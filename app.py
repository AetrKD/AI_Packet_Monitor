from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO
import threading
from ai_service import analyze_packet, get_status, get_config
from database import start_db_writer, query_history, start_highlight_db_writer, query_highlight_history, delete_history_packets, delete_highlight_packets

# sniffer 모듈에서 기능 임포트
from sniffer import start_sniffing, set_pause, set_filter, set_emit_callback, set_saving, set_highlight_rules

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*")

# sniffer.py에서 SocketIO 이벤트를 발생시킬 수 있도록 콜백 등록
set_emit_callback(socketio.emit)


@app.route('/')
def index():
    # 데이터베이스 백그라운드 워커 시작
    start_db_writer()
    start_highlight_db_writer()
    return render_template('index.html')


@app.route('/api/analyze', methods=['POST'])
def api_analyze():
    """패킷 데이터를 받아 AI 분석 결과를 반환합니다."""
    try:
        packet_data = request.get_json(force=True)
        if not packet_data:
            return jsonify({"success": False, "error": "요청 바디가 비어 있습니다."}), 400
        result = analyze_packet(packet_data)
        return jsonify(result)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/toggle-pause', methods=['POST'])
def api_toggle_pause():
    """패킷 캡쳐 일시정지 상태를 변경합니다."""
    try:
        data = request.get_json(force=True)
        is_paused = data.get('paused', False)
        set_pause(is_paused)  # sniffer 측 상태 변경
        return jsonify({"success": True, "paused": is_paused})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/toggle-save', methods=['POST'])
def api_toggle_save():
    """패킷 DB 저장 상태를 변경합니다."""
    try:
        data = request.get_json(force=True)
        is_saving = data.get('saving', False)
        set_saving(is_saving)  # sniffer 측 상태 변경
        return jsonify({"success": True, "saving": is_saving})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/history', methods=['POST'])
def api_history():
    """저장된 패킷 이력을 조회합니다."""
    try:
        data = request.get_json(force=True)
        ret = query_history(data)
        return jsonify({"success": True, "data": ret["data"], "total": ret["total"]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/set-filter', methods=['POST'])
def api_set_filter():
    """패킷 캡쳐 필터 조건을 설정합니다."""
    try:
        data = request.get_json(force=True)
        new_filter = {
            'ip': data.get('ip', '').strip(),
            'port': data.get('port', '').strip(),
            'proto': data.get('proto', '').strip(),
            'dir': data.get('dir', '').strip(),
            'min_size': data.get('min_size', '').strip(),
            'max_size': data.get('max_size', '').strip(),
        }
        set_filter(new_filter)  # sniffer 측 필터 업데이트
        return jsonify({"success": True, "filter": new_filter})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/highlight-history', methods=['POST'])
def api_highlight_history():
    """강조 및 자동저장된 별도 패킷 이력을 조회합니다."""
    try:
        data = request.get_json(force=True)
        ret = query_highlight_history(data)
        return jsonify({"success": True, "data": ret["data"], "total": ret["total"]})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/delete-packets', methods=['POST'])
def api_delete_packets():
    """아카이브 또는 강조 탭에서 선택한 패킷들을 삭제합니다."""
    try:
        data = request.get_json(force=True)
        db_type = data.get('db_type', 'ARCHIVE')
        ids = data.get('ids', [])
        
        if db_type == 'HIGHLIGHT':
            deleted_count = delete_highlight_packets(ids)
        else:
            deleted_count = delete_history_packets(ids)
            
        return jsonify({"success": True, "deleted_count": deleted_count})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/api/set-highlight-rules', methods=['POST'])
def api_set_highlight_rules():
    """패킷 강조(다중 규칙) 조건을 설정합니다."""
    try:
        data = request.get_json(force=True)
        rules = data.get('rules', [])
        cleaned_rules = []
        for r in rules:
            ip = r.get('ip', '').strip()
            port = r.get('port', '').strip()
            proto = r.get('proto', '').strip()
            direction = r.get('dir', '').strip()
            min_size = str(r.get('min_size', '')).strip()
            max_size = str(r.get('max_size', '')).strip()

            if not any([ip, port, proto, direction, min_size, max_size]):
                continue

            cleaned_rules.append({
                'ip': ip,
                'port': port,
                'proto': proto,
                'dir': direction,
                'min_size': min_size,
                'max_size': max_size,
            })
        set_highlight_rules(cleaned_rules)
        return jsonify({"success": True, "rules": cleaned_rules})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/ai-status', methods=['GET'])
def api_ai_status():
    """AI API 키 설정 상태를 반환합니다."""
    return jsonify(get_status())


if __name__ == '__main__':
    # config.json 에서 서버 설정 로드
    _cfg = get_config().get("server", {})
    _host = _cfg.get("host", "0.0.0.0")
    _port = int(_cfg.get("port", 25565))

    # 패킷 캡쳐를 별도 스레드에서 실행
    sniff_thread = threading.Thread(target=start_sniffing, daemon=True)
    sniff_thread.start()

    # Flask 서버 실행
    print(f"서버 시작: http://{_host}:{_port}")
    socketio.run(app, host=_host, port=_port, debug=True, allow_unsafe_werkzeug=True)
