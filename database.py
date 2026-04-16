import sqlite3
import threading
import queue
import time
from pathlib import Path

DB_FILE = Path(__file__).parent / "packets.db"

class DBManager:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.packet_queue = queue.Queue()
        self.db_thread = None
        self.running = False

    def init_db(self):
        """데이터베이스 파일 및 테이블 생성"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS packets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                src TEXT,
                dst TEXT,
                proto TEXT,
                size INTEGER,
                direction TEXT,
                summary TEXT,
                raw_hex TEXT,
                is_saved INTEGER DEFAULT 0,
                is_highlighted INTEGER DEFAULT 0
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS ip_aliases (
                ip TEXT PRIMARY KEY,
                name TEXT NOT NULL
            )
        """)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS packet_rules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL DEFAULT 'HIGHLIGHT',
                ip TEXT,
                port TEXT,
                proto TEXT,
                direction TEXT,
                min_size TEXT,
                max_size TEXT,
                description TEXT DEFAULT ''
            )
        """)
        # 기존 DB 마이그레이션: description 컬럼이 없으면 추가
        try:
            cursor.execute("ALTER TABLE packet_rules ADD COLUMN description TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass  # 이미 존재
        conn.commit()
        conn.close()

    def _db_worker(self):
        """백그라운드에서 큐의 데이터를 꺼내어 DB에 저장하는 스레드"""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        batch_size = 50
        
        while self.running or not self.packet_queue.empty():
            items = []
            try:
                items.append(self.packet_queue.get(timeout=1.0))
                # 큐에 쌓인 것들 최대 batch_size만큼 더 가져오기 (성능 향상)
                while len(items) < batch_size and not self.packet_queue.empty():
                    items.append(self.packet_queue.get_nowait())
            except queue.Empty:
                continue
                
            if items:
                cursor.executemany("""
                    INSERT INTO packets (timestamp, src, dst, proto, size, direction, summary, raw_hex, is_saved, is_highlighted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, items)
                conn.commit()
                
                for _ in items:
                    self.packet_queue.task_done()
                    
        conn.close()

    def start_writer(self):
        """비동기 DB 저장 스레드 시작"""
        if self.running:
            return
            
        self.init_db()
        self.running = True
        self.db_thread = threading.Thread(target=self._db_worker, daemon=True)
        self.db_thread.start()

    def save_packet_async(self, packet_data: dict, time_str: str, is_saved: bool, is_highlighted: bool):
        """엔진에서 호출하여 패킷을 큐에 적재합니다."""
        if not self.running:
            return
            
        row = (
            time_str,
            packet_data.get("src"),
            packet_data.get("dst"),
            packet_data.get("proto"),
            packet_data.get("len", 0),
            packet_data.get("direction"),
            packet_data.get("summary"),
            packet_data.get("raw"),
            1 if is_saved else 0,
            1 if is_highlighted else 0
        )
        self.packet_queue.put(row)

    def query_history(self, filters: dict, db_type: str = 'ARCHIVE'):
        """저장된 패킷 이력과 총 개수를 조회합니다."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        where_clause = " FROM packets WHERE 1=1"
        
        if db_type == 'HIGHLIGHT':
            where_clause += " AND is_highlighted = 1"
        else:
            where_clause += " AND is_saved = 1"
            
        params = []
        
        f_ip = filters.get("ip", "").strip()
        if f_ip:
            where_clause += " AND (src LIKE ? OR dst LIKE ?)"
            params.extend([f"%{f_ip}%", f"%{f_ip}%"])
            
        f_proto = filters.get("proto", "").strip()
        if f_proto:
            where_clause += " AND proto = ?"
            params.append(f_proto.upper())
            
        f_dir = filters.get("dir", "").strip()
        if f_dir:
            where_clause += " AND direction = ?"
            params.append(f_dir.upper())
            
        f_min = filters.get("min_size", "").strip()
        if f_min.isdigit():
            where_clause += " AND size >= ?"
            params.append(int(f_min))
            
        f_max = filters.get("max_size", "").strip()
        if f_max.isdigit():
            where_clause += " AND size <= ?"
            params.append(int(f_max))
            
        f_start = filters.get("start_time", "").strip()
        if f_start:
            where_clause += " AND timestamp >= ?"
            params.append(f_start)
            
        f_end = filters.get("end_time", "").strip()
        if f_end:
            where_clause += " AND timestamp <= ?"
            params.append(f_end)
            
        # 1. Total Count
        count_query = "SELECT COUNT(*)" + where_clause
        cursor.execute(count_query, params)
        total_count = cursor.fetchone()[0]
        
        # 2. 페이징 적용된 실제 데이터
        limit = int(filters.get("limit", 1000))
        page = int(filters.get("page", 1))
        offset = (page - 1) * limit
        
        data_query = "SELECT *" + where_clause + " ORDER BY id DESC LIMIT ? OFFSET ?"
        data_params = params + [limit, offset]
        
        cursor.execute(data_query, data_params)
        rows = cursor.fetchall()
        
        results = []
        for row in rows:
            results.append({
                "no": row["id"],
                "time": row["timestamp"],
                "src": row["src"],
                "dst": row["dst"],
                "proto": row["proto"],
                "len": row["size"],
                "direction": row["direction"],
                "summary": row["summary"],
                "raw": row["raw_hex"]
            })
            
        conn.close()
        return {"data": results, "total": total_count}

    def delete_packets(self, ids: list[int], db_type: str = 'ARCHIVE') -> int:
        """지정된 id 목록에 해당하는 패킷들을 논리 삭제합니다."""
        if not ids:
            return 0
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        placeholders = ','.join(['?'] * len(ids))
        
        if db_type == 'HIGHLIGHT':
            cursor.execute(f"UPDATE packets SET is_highlighted = 0 WHERE id IN ({placeholders})", ids)
        else:
            cursor.execute(f"UPDATE packets SET is_saved = 0 WHERE id IN ({placeholders})", ids)
            
        # 둘 다 0이 되면 완전 삭제
        cursor.execute("DELETE FROM packets WHERE is_saved = 0 AND is_highlighted = 0")
        
        conn.commit()
        conn.close()
        return len(ids)

    def get_aliases(self) -> dict:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT ip, name FROM ip_aliases")
            rows = cursor.fetchall()
        except sqlite3.OperationalError:
            rows = []
        conn.close()
        return {row[0]: row[1] for row in rows}

    def set_alias(self, ip: str, name: str):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO ip_aliases (ip, name) VALUES (?, ?)", (ip, name))
        conn.commit()
        conn.close()

    def delete_alias(self, ip: str):
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM ip_aliases WHERE ip = ?", (ip,))
        conn.commit()
        conn.close()

    def get_rules(self) -> list:
        """DB에 저장된 패킷 규칙(강조/무시) 목록을 불러옵니다."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        try:
            cursor.execute("SELECT action, ip, port, proto, direction, min_size, max_size, description FROM packet_rules ORDER BY id")
            rows = cursor.fetchall()
        except sqlite3.OperationalError:
            rows = []
        conn.close()
        return [{
            'action': row['action'],
            'ip': row['ip'] or '',
            'port': row['port'] or '',
            'proto': row['proto'] or '',
            'dir': row['direction'] or '',
            'min_size': row['min_size'] or '',
            'max_size': row['max_size'] or '',
            'description': row['description'] or '',
        } for row in rows]

    def save_rules(self, rules: list):
        """패킷 규칙 목록을 DB에 전체 덮어쓰기합니다."""
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM packet_rules")
        for r in rules:
            cursor.execute("""
                INSERT INTO packet_rules (action, ip, port, proto, direction, min_size, max_size, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                r.get('action', 'HIGHLIGHT'),
                r.get('ip', ''),
                r.get('port', ''),
                r.get('proto', ''),
                r.get('dir', ''),
                r.get('min_size', ''),
                r.get('max_size', ''),
                r.get('description', ''),
            ))
        conn.commit()
        conn.close()

# 전역 싱글턴 인스턴스
main_db = DBManager(DB_FILE)

def init_db():
    main_db.init_db()

def start_db_writer():
    main_db.start_writer()

def save_packet_async(packet_data: dict, time_str: str, is_saved: bool, is_highlighted: bool):
    main_db.save_packet_async(packet_data, time_str, is_saved, is_highlighted)

def query_history(filters: dict):
    return main_db.query_history(filters, db_type='ARCHIVE')

def query_highlight_history(filters: dict):
    return main_db.query_history(filters, db_type='HIGHLIGHT')

def delete_history_packets(ids: list[int]):
    return main_db.delete_packets(ids, db_type='ARCHIVE')

def delete_highlight_packets(ids: list[int]):
    return main_db.delete_packets(ids, db_type='HIGHLIGHT')

def get_aliases():
    return main_db.get_aliases()

def set_alias(ip: str, name: str):
    main_db.set_alias(ip, name)

def delete_alias(ip: str):
    main_db.delete_alias(ip)

def get_rules():
    return main_db.get_rules()

def save_rules(rules: list):
    main_db.save_rules(rules)
