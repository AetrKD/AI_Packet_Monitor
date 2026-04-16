import socket as sock
from scapy.all import sniff, IP, TCP, UDP
from datetime import datetime
from database import save_packet_async

# ─── 상태 변수 ──────────────────────────────────
packet_count = 0
is_paused = False
is_saving = False
current_filter = {}
packet_rules = [] # [{'action': 'IGNORE'|'HIGHLIGHT', 'ip': ...}]

# 이벤트 전송 콜백 함수 (app.py의 socketio.emit 연결용)
_emit_callback = None


def set_emit_callback(callback):
    """소켓 전송용 콜백 함수를 등록합니다."""
    global _emit_callback
    _emit_callback = callback


def set_pause(paused: bool):
    """일시정지 상태를 변경합니다."""
    global is_paused
    is_paused = paused

def set_saving(saving: bool):
    """DB 저장 상태를 변경합니다."""
    global is_saving
    is_saving = saving


def set_filter(filter_dict: dict):
    """패킷 필터링 조건을 변경합니다."""
    global current_filter
    current_filter = filter_dict

def set_packet_rules(rules: list):
    """지정된 패킷을 무시 또는 강조하는 규칙을 설정합니다."""
    global packet_rules
    packet_rules = rules


def get_local_ips():
    """현재 머신의 모든 로컬 IP 주소를 반환"""
    ips = {'127.0.0.1'}
    try:
        hostname = sock.gethostname()
        for info in sock.getaddrinfo(hostname, None):
            ips.add(info[4][0])
    except Exception:
        pass
    return ips

LOCAL_IPS = get_local_ips()

def check_filter_match(f_dict: dict, src: str, dst: str, sport, dport, proto_name: str, direction: str, pkt_len: int) -> bool:
    """주어진 패킷 정보가 특정 필터 딕셔너리 조건에 부합하는지 검사합니다."""
    if not f_dict:
        return True
        
    f_ip = f_dict.get('ip')
    if f_ip and (f_ip not in src and f_ip not in dst):
        return False
        
    f_port = f_dict.get('port')
    if f_port:
        try:
            fp = int(f_port)
            if fp not in (sport, dport): return False
        except ValueError: pass
        
    f_proto = f_dict.get('proto')
    if f_proto and f_proto != proto_name:
        return False
        
    f_dir = f_dict.get('dir')
    if f_dir and f_dir != direction:
        return False
        
    f_min = f_dict.get('min_size')
    if f_min:
        try:
            if pkt_len < int(f_min): return False
        except ValueError: pass
        
    f_max = f_dict.get('max_size')
    if f_max:
        try:
            if pkt_len > int(f_max): return False
        except ValueError: pass
        
    return True

def packet_callback(packet):
    global packet_count, is_paused, is_saving, current_filter, packet_rules
    
    # 1. 일시정지 체크
    if is_paused:
        return
        
    if IP in packet:
        # 기본 정보 추출
        src = packet[IP].src
        dst = packet[IP].dst
        proto_name = "OTHER"
        sport, dport = None, None

        if TCP in packet:
            proto_name = "TCP"
            sport = packet[TCP].sport
            dport = packet[TCP].dport
        elif UDP in packet:
            proto_name = "UDP"
            sport = packet[UDP].sport
            dport = packet[UDP].dport

        # 방향 판단
        if dst in LOCAL_IPS:
            direction = "INBOUND"
        elif src in LOCAL_IPS:
            direction = "OUTBOUND"
        else:
            direction = "OTHER"
            
        pkt_len = len(packet)

        # ====== 캡처 필터 검사 (AND 조건) ======
        if not check_filter_match(current_filter, src, dst, sport, dport, proto_name, direction, pkt_len):
            return
        # ================================

        # ====== 패킷 규칙 검사 (무시/강조) ======
        is_highlight = False
        if packet_rules:
            for rule in packet_rules:
                if check_filter_match(rule, src, dst, sport, dport, proto_name, direction, pkt_len):
                    action = rule.get('action', 'HIGHLIGHT')
                    if action == 'IGNORE':
                        return # 조용히 폐기
                    elif action == 'HIGHLIGHT':
                        is_highlight = True
                        # 계속 진행 (다른 규칙에 IGNORE가 있을 수 있으나 단순성을 위해 break)
                        break

        # 필터 통과시만 카운트 증가
        packet_count += 1

        # ==== 시간 생성 (YYYY-MM-DD HH:MM:SS) ====
        time_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        # 데이터 조합
        packet_data = {
            "no": packet_count,
            "time": time_str,
            "src": src,
            "dst": dst,
            "proto": proto_name,
            "len": pkt_len,
            "summary": packet.summary(),
            "direction": direction,
            "raw": bytes(packet).hex(),
            "highlight": is_highlight
        }
        
        # DB 저장 조건이 하나라도 만족하면 큐에 적재
        if is_saving or is_highlight:
            save_packet_async(packet_data, time_str, is_saved=is_saving, is_highlighted=is_highlight)
        
        # app.py로 데이터 전송 (등록된 콜백이 있다면)
        if _emit_callback:
            _emit_callback('new_packet', packet_data)


def start_sniffing():
    import ctypes, sys
    # ── 관리자 권한 확인 (Windows) ───
    try:
        is_admin = ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        is_admin = None

    if is_admin == 0:
        print("=" * 60)
        print("[ERROR] 관리자 권한이 없습니다!")
        print("  → PyCharm을 '관리자 권한으로 실행'해야 패킷 캡처가 가능합니다.")
        print("=" * 60)
        return

    # ── Npcap / WinPcap 설치 확인 ───
    try:
        from scapy.arch.windows import get_windows_if_list
        ifaces = get_windows_if_list()
        if not ifaces:
            print("[WARNING] 네트워크 인터페이스를 찾지 못했습니다. Npcap이 설치되어 있는지 확인하세요.")
    except Exception as e:
        print(f"[WARNING] 인터페이스 목록 조회 실패: {e}")

    # ── 실제 패킷 캡처 시작 ───
    try:
        import json
        from pathlib import Path
        config_path = Path(__file__).parent / "config.json"
        target_iface = None
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                target_iface = cfg.get("server", {}).get("iface")
                if not target_iface or target_iface == "all":
                    target_iface = None
        except Exception:
            pass

        if target_iface:
            print(f"[INFO] '{target_iface}' 어댑터에서 패킷 캡처 시작...")
            sniff(iface=target_iface, prn=packet_callback, store=0)
        else:
            print("[INFO] 전체/기본 어댑터에서 패킷 캡처 시작...")
            sniff(prn=packet_callback, store=0)
    except PermissionError as e:
        print("=" * 60)
        print("[ERROR] 권한 오류 - PyCharm을 관리자 권한으로 실행하세요.")
        print(f"  상세: {e}")
        print("=" * 60)
    except OSError as e:
        print("=" * 60)
        print("[ERROR] Npcap이 설치되어 있지 않거나 인터페이스를 열 수 없습니다.")
        print("  → https://npcap.com 에서 Npcap을 설치하세요.")
        print(f"  상세: {e}")
        print("=" * 60)
    except Exception as e:
        print("=" * 60)
        print(f"[ERROR] 패킷 캡처 실패: {type(e).__name__}: {e}")
        print("=" * 60)
