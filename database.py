import sqlite3
import threading
import queue
import time
from pathlib import Path

DB_FILE = Path(__file__).parent / "packets.db"
HIGHLIGHT_DB_FILE = Path(__file__).parent / "highlighted_packets.db"

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
                raw_hex TEXT
            )
        """)
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
                # 타임아웃을 두어 주기적으로 self.running 체크
                items.append(self.packet_queue.get(timeout=1.0))
                # 큐에 쌓인 것들 최대 batch_size만큼 더 가져오기 (성능 향상)
                while len(items) < batch_size and not self.packet_queue.empty():
                    items.append(self.packet_queue.get_nowait())
            except queue.Empty:
                continue
                
            if items:
                cursor.executemany("""
                    INSERT INTO packets (timestamp, src, dst, proto, size, direction, summary, raw_hex)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, items)
                conn.commit()
                
                # task_done 호출
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

    def save_packet_async(self, packet_data: dict, time_str: str):
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
            packet_data.get("raw")
        )
        self.packet_queue.put(row)

    def query_history(self, filters: dict):
        """저장된 패킷 이력과 총 개수를 조회합니다."""
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        
        where_clause = " FROM packets WHERE 1=1"
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

    def delete_packets(self, ids: list[int]) -> int:
        """지정된 id 목록에 해당하는 패킷들을 삭제합니다."""
        if not ids:
            return 0
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        placeholders = ','.join(['?'] * len(ids))
        cursor.execute(f"DELETE FROM packets WHERE id IN ({placeholders})", ids)
        deleted_count = cursor.rowcount
        conn.commit()
        conn.close()
        return deleted_count

# 정적 인스턴스로 호환성 유지 및 확장
main_db = DBManager(DB_FILE)
highlight_db = DBManager(HIGHLIGHT_DB_FILE)

def init_db():
    main_db.init_db()
    highlight_db.init_db()

def start_db_writer():
    main_db.start_writer()

def save_packet_async(packet_data: dict, time_str: str):
    main_db.save_packet_async(packet_data, time_str)

def query_history(filters: dict):
    return main_db.query_history(filters)

def start_highlight_db_writer():
    highlight_db.start_writer()

def save_highlight_packet_async(packet_data: dict, time_str: str):
    highlight_db.save_packet_async(packet_data, time_str)

def query_highlight_history(filters: dict):
    return highlight_db.query_history(filters)

def delete_history_packets(ids: list[int]):
    return main_db.delete_packets(ids)

def delete_highlight_packets(ids: list[int]):
    return highlight_db.delete_packets(ids)
