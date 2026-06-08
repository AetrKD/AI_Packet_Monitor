from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import asyncio
import threading
import time
import logging
import concurrent.futures
import json
from pathlib import Path
from ai_service import analyze_packet, analyze_packets_batch, get_status, get_config, reload_config
from database import start_db_writer, query_history, query_highlight_history, delete_history_packets, delete_highlight_packets, get_aliases, set_alias, delete_alias, get_rules, save_rules

# sniffer 모듈에서 기능 임포트
from sniffer import start_sniffing, set_pause, set_filter, set_emit_callback, set_saving, set_packet_rules, auto_analysis_queue

# 전역 상태 변수
_main_loop: asyncio.AbstractEventLoop | None = None
_ws_clients: set[WebSocket] = set()
_ws_lock = asyncio.Lock()
_packet_queue = asyncio.Queue(maxsize=5000) # 패킷 전송용 큐

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작/종료 시 자원 관리"""
    global _main_loop
    _main_loop = asyncio.get_running_loop()

    # DB 초기화 및 백그라운드 워커 시작
    start_db_writer()

    # DB에서 저장된 패킷 규칙 복원
    try:
        saved_rules = get_rules()
        if saved_rules:
            set_packet_rules(saved_rules)
            print(f"[INFO] DB에서 패킷 규칙 {len(saved_rules)}개 복원 완료")
    except Exception as e:
        print(f"[WARNING] 패킷 규칙 복원 실패: {e}")

    # 패킷 캡쳐를 별도 스레드에서 실행
    sniff_thread = threading.Thread(target=start_sniffing, daemon=True)
    sniff_thread.start()

    # 자동 AI 분석 백그라운드 워커 시작
    ai_worker_thread = threading.Thread(target=auto_analysis_worker, daemon=True)
    ai_worker_thread.start()

    # 패킷 배치 전송 워커 시작 (비동기)
    asyncio.create_task(packet_batch_worker())

    # sniffer 콜백 재등록
    set_emit_callback(sync_broadcast)
    
    yield

app = FastAPI(lifespan=lifespan)

# 정적 파일 및 템플릿 설정
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# AI 분석 요청을 처리할 스레드 풀 (최대 4개 동시 분석)
_ai_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)



async def broadcast(event: str, data: dict):
    """연결된 모든 WebSocket 클라이언트에 메시지를 브로드캐스트합니다."""
    message = json.dumps({"event": event, "data": data}, ensure_ascii=False)
    async with _ws_lock:
        dead = set()
        for ws in _ws_clients:
            try:
                await ws.send_text(message)
            except Exception:
                dead.add(ws)
        _ws_clients -= dead


async def packet_batch_worker():
    """큐에 쌓인 패킷을 일정 시간마다 모아서 클라이언트에 전송합니다."""
    while True:
        try:
            packets = []
            # 첫 번째 패킷 대기 (비어있으면 여기서 대기)
            first_pkt = await _packet_queue.get()
            packets.append(first_pkt)
            
            # 짧은 시간 동안 추가 패킷 수집 (최대 100개 또는 0.1초)
            try:
                start_time = time.time()
                while len(packets) < 100 and (time.time() - start_time) < 0.1:
                    if _packet_queue.empty():
                        await asyncio.sleep(0.01)
                        continue
                    packets.append(_packet_queue.get_nowait())
            except asyncio.QueueEmpty:
                pass
            
            if packets:
                await broadcast('new_packets', packets) # 'new_packet' 대신 'new_packets' (배치)
                
        except Exception as e:
            print(f"[DEBUG] Batch worker error: {e}")
            await asyncio.sleep(0.1)

def sync_broadcast(event: str, data: dict):
    """동기 코드(sniffer 콜백 등)에서 패킷을 큐에 넣거나 즉시 브로드캐스트합니다."""
    if not _main_loop: return

    if event == 'new_packet':
        # 실시간 패킷은 큐에 넣어 배치 처리
        try:
            _main_loop.call_soon_threadsafe(_packet_queue.put_nowait, data)
        except asyncio.QueueFull:
            try: _packet_queue.get_nowait() # 오래된 것 하나 버림
            except: pass
            _main_loop.call_soon_threadsafe(_packet_queue.put_nowait, data)
    else:
        # AI 알림 등 중요한 개별 이벤트는 즉시 전송
        try:
            asyncio.run_coroutine_threadsafe(broadcast(event, data), _main_loop)
        except Exception as e:
            print(f"[DEBUG] Broadcast error: {e}")

# sniffer.py에서 WebSocket 이벤트를 발생시킬 수 있도록 콜백 등록
set_emit_callback(sync_broadcast)


@app.get('/', response_class=HTMLResponse)
async def index(request: Request):
    # 데이터베이스 백그라운드 워커 시작 (통합)
    start_db_writer()
    return templates.TemplateResponse(request, "index.html")


@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
    """WebSocket 엔드포인트: 클라이언트 연결 관리."""
    await ws.accept()
    client_host = ws.client.host if ws.client else "unknown"
    print(f"[INFO] WebSocket 연결됨: {client_host}")
    async with _ws_lock:
        _ws_clients.add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        print(f"[INFO] WebSocket 연결 끊김: {client_host}")
    finally:
        async with _ws_lock:
            _ws_clients.discard(ws)


@app.post('/api/analyze')
async def api_analyze(request: Request):
    """패킷 데이터를 받아 AI 분석 결과를 반환합니다."""
    try:
        packet_data = await request.json()
        if not packet_data:
            return JSONResponse({'success': False, 'error': '패킷 데이터가 없습니다.'}, status_code=400)
        # 별도 스레드에서 실행하여 이벤트 루프 블로킹 방지
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_ai_executor, analyze_packet, packet_data)
        return JSONResponse(result)
    except concurrent.futures.TimeoutError:
        return JSONResponse({'success': False, 'error': 'AI 분석 시간 초과 (60초)'}, status_code=504)
    except Exception as e:
        return JSONResponse({'success': False, 'error': str(e)}, status_code=500)


@app.post('/api/toggle-pause')
async def api_toggle_pause(request: Request):
    """패킷 캡쳐 일시정지 상태를 변경합니다."""
    try:
        data = await request.json()
        is_paused = data.get('paused', False)
        set_pause(is_paused)  # sniffer 측 상태 변경
        return JSONResponse({"success": True, "paused": is_paused})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/toggle-save')
async def api_toggle_save(request: Request):
    """패킷 DB 저장 상태를 변경합니다."""
    try:
        data = await request.json()
        is_saving = data.get('saving', False)
        set_saving(is_saving)  # sniffer 측 상태 변경
        return JSONResponse({"success": True, "saving": is_saving})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/history')
async def api_history(request: Request):
    """저장된 패킷 이력을 조회합니다."""
    try:
        data = await request.json()
        ret = query_history(data)
        return JSONResponse({"success": True, "data": ret["data"], "total": ret["total"]})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/set-filter')
async def api_set_filter(request: Request):
    """패킷 캡쳐 필터 조건을 설정합니다."""
    try:
        data = await request.json()
        new_filter = {
            'ip': data.get('ip', '').strip(),
            'port': data.get('port', '').strip(),
            'proto': data.get('proto', '').strip(),
            'dir': data.get('dir', '').strip(),
            'min_size': data.get('min_size', '').strip(),
            'max_size': data.get('max_size', '').strip(),
        }
        set_filter(new_filter)  # sniffer 측 필터 업데이트
        return JSONResponse({"success": True, "filter": new_filter})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/highlight-history')
async def api_highlight_history(request: Request):
    """강조 및 자동저장된 별도 패킷 이력을 조회합니다."""
    try:
        data = await request.json()
        ret = query_highlight_history(data)
        return JSONResponse({"success": True, "data": ret["data"], "total": ret["total"]})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/delete-packets')
async def api_delete_packets(request: Request):
    """아카이브 또는 강조 탭에서 선택한 패킷들을 삭제합니다."""
    try:
        data = await request.json()
        db_type = data.get('db_type', 'ARCHIVE')
        ids = data.get('ids', [])

        if db_type == 'HIGHLIGHT':
            deleted_count = delete_highlight_packets(ids)
        else:
            deleted_count = delete_history_packets(ids)

        return JSONResponse({"success": True, "deleted_count": deleted_count})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/set-rules')
async def api_set_rules(request: Request):
    """패킷 필터링 규칙(무시/강조)을 설정합니다."""
    try:
        data = await request.json()
        rules = data.get('rules', [])
        cleaned_rules = []
        for r in rules:
            action = r.get('action', 'HIGHLIGHT').strip().upper()
            if action not in ['HIGHLIGHT', 'IGNORE']:
                action = 'HIGHLIGHT'
            ip = r.get('ip', '').strip()
            port = r.get('port', '').strip()
            proto = r.get('proto', '').strip()
            direction = r.get('dir', '').strip()
            min_size = str(r.get('min_size', '')).strip()
            max_size = str(r.get('max_size', '')).strip()
            description = r.get('description', '').strip()

            if not any([ip, port, proto, direction, min_size, max_size]):
                continue

            cleaned_rules.append({
                'action': action,
                'ip': ip,
                'port': port,
                'proto': proto,
                'dir': direction,
                'min_size': min_size,
                'max_size': max_size,
                'description': description,
            })
        set_packet_rules(cleaned_rules)
        # DB에도 영구 저장
        save_rules(cleaned_rules)
        return JSONResponse({"success": True, "rules": cleaned_rules})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.get('/api/rules')
async def api_get_rules():
    """DB에 저장된 패킷 규칙 목록을 반환합니다."""
    try:
        rules = get_rules()
        return JSONResponse({"success": True, "rules": rules})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.get('/api/aliases')
async def api_aliases_get():
    """IP 별명을 조회합니다."""
    try:
        return JSONResponse({"success": True, "data": get_aliases()})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/aliases')
async def api_aliases_post(request: Request):
    """IP 별명을 추가/수정합니다."""
    try:
        data = await request.json()
        ip = data.get('ip', '').strip()
        name = data.get('name', '').strip()
        if not ip or not name:
            return JSONResponse({"success": False, "error": "IP와 이름이 모두 필요합니다."}, status_code=400)
        set_alias(ip, name)
        return JSONResponse({"success": True, "ip": ip, "name": name})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.delete('/api/aliases')
async def api_aliases_delete(request: Request):
    """IP 별명을 삭제합니다."""
    try:
        data = await request.json()
        ip = data.get('ip', '').strip()
        if not ip:
            return JSONResponse({"success": False, "error": "IP가 필요합니다."}, status_code=400)
        delete_alias(ip)
        return JSONResponse({"success": True, "ip": ip})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.get('/api/config')
async def api_config_get():
    """시스템 및 AI 설정을 반환합니다."""
    config_path = Path(__file__).parent / "config.json"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return JSONResponse({"success": True, "data": json.load(f)})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post('/api/config')
async def api_config_post(request: Request):
    """시스템 및 AI 설정을 업데이트합니다."""
    config_path = Path(__file__).parent / "config.json"
    try:
        new_config = await request.json()
        if not new_config:
            return JSONResponse({"success": False, "error": "데이터가 없습니다."}, status_code=400)

        with open(config_path, "w", encoding="utf-8") as f:
            json.dump(new_config, f, indent=4, ensure_ascii=False)

        # AI 모듈 핫 리로드 적용
        reload_config()
        return JSONResponse({"success": True, "message": "설정이 저장 및 적용되었습니다."})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.get('/api/interfaces')
async def api_interfaces():
    """현재 시스템에 설치된 네트워크 어댑터 목록을 반환합니다."""
    try:
        from scapy.arch.windows import get_windows_if_list
        if_list = get_windows_if_list()
        # if_list는 [{'name': '...', 'description': '...', 'mac': '...'}, ...] 형태입니다.
        result = []
        for iface in if_list:
            if iface.get('description'):
                result.append({
                    "name": iface.get('name'),
                    "desc": iface.get('description')
                })
        return JSONResponse({"success": True, "data": result})
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e), "data": []}, status_code=500)


@app.get('/api/ai-status')
async def api_ai_status():
    """AI API 키 설정 상태를 반환합니다."""
    return JSONResponse(get_status())


# ─── 자동 AI 분석 수동 상태 및 워커 ────────────────────────────
_auto_analysis_enabled = False
_AUTO_ANALYSIS_INTERVAL = 3.0  # 최소 API 호출 간격 (초)
_main_loop: asyncio.AbstractEventLoop | None = None


def auto_analysis_worker():
    """백그라운드에서 큐를 감시하다 HIGHLIGHT 패킷을 AI로 분석합니다."""
    last_call = 0.0
    logger = logging.getLogger(__name__)
    while True:
        try:
            packet_data = auto_analysis_queue.get(timeout=1.0)
            if not _auto_analysis_enabled:
                continue
            # Rate limit 준수
            elapsed = time.time() - last_call
            if elapsed < _AUTO_ANALYSIS_INTERVAL:
                time.sleep(_AUTO_ANALYSIS_INTERVAL - elapsed)
            result = analyze_packet(packet_data)
            last_call = time.time()
            if result.get('success') and _main_loop:
                asyncio.run_coroutine_threadsafe(
                    broadcast('ai_alert', {
                        'packet': packet_data,
                        'analysis': result
                    }),
                    _main_loop
                )
        except Exception:
            pass  # queue.Empty 포함 조용히 스킵


@app.post('/api/auto-analysis-toggle')
async def api_auto_analysis_toggle(request: Request):
    """자동 AI 분석 기능을 ON/OFF 합니다."""
    global _auto_analysis_enabled
    try:
        data = await request.json()
        _auto_analysis_enabled = bool(data.get('enabled', False))
        return JSONResponse({'success': True, 'enabled': _auto_analysis_enabled})
    except Exception as e:
        return JSONResponse({'success': False, 'error': str(e)}, status_code=500)


@app.post('/api/analyze-batch')
async def api_analyze_batch(request: Request):
    """선택된 패킷 목록을 한 번에 AI로 종합 분석합니다."""
    try:
        data = await request.json()
        packets = data.get('packets', [])
        if not packets:
            return JSONResponse({'success': False, 'error': '패킷 데이터가 없습니다.'}, status_code=400)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_ai_executor, analyze_packets_batch, packets)
        return JSONResponse(result)
    except concurrent.futures.TimeoutError:
        return JSONResponse({'success': False, 'error': 'AI 분석 시간 초과 (120초)'}, status_code=504)
    except Exception as e:
        return JSONResponse({'success': False, 'error': str(e)}, status_code=500)




if __name__ == '__main__':
    import uvicorn

    # config.json 에서 서버 설정 로드
    _cfg = get_config().get("server", {})
    _host = _cfg.get("host", "0.0.0.0")
    _port = int(_cfg.get("port", 25565))

    print(f"서버 시작: http://{_host}:{_port}")
    uvicorn.run(app, host=_host, port=_port)
