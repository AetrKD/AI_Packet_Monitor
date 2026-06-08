"""
ai_service.py
─────────────
네트워크 패킷 데이터를 AI로 분석하는 핵심 서비스 모듈.

지원 백엔드:
  ① Google Gemini (Native 2.0 SDK) : 최신 google-genai 라이브러리 사용
  ② OpenAI 호환 API (OpenAI Cloud, LM Studio, Ollama 등)
"""

import json
import logging
import urllib.request
import ipaddress
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# ─── 설정 로드 ──────────────────────────────────────────────
_CONFIG_PATH = Path(__file__).parent / "config.json"

def _load_config() -> dict:
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error("config.json 로드 실패: %s", e)
        return {}

_config = {}
_ai_cfg = {}
_openai_client = None
_gemini_client = None

def reload_config():
    """설정을 다시 로드하고 AI 클라이언트를 초기화합니다."""
    global _config, _ai_cfg, _openai_client, _gemini_client
    _config = _load_config()
    _ai_cfg = _config.get("ai", {})

    api_key = str(_ai_cfg.get("api_key", ""))
    base_url = str(_ai_cfg.get("base_url", "")).strip() or None
    model_name = str(_ai_cfg.get("model", "models/gemini-flash-latest"))
    timeout = float(_ai_cfg.get("timeout", 30))

    _openai_client = None
    _gemini_client = None

    # 1. Gemini Native SDK (google-genai) 사용 조건 확인
    is_gemini = "gemini" in model_name.lower() and (not base_url or "generativelanguage" in base_url)

    if is_gemini and api_key:
        try:
            from google import genai
            _gemini_client = genai.Client(api_key=api_key)
            logger.info("AI 백엔드: Google Gemini (Native 2026 SDK) | 모델: %s", model_name)
            return
        except Exception as e:
            logger.error("Gemini SDK 초기화 실패: %s", e)

    # 2. OpenAI 호환 클라이언트 사용
    try:
        from openai import OpenAI
        _openai_client = OpenAI(api_key=api_key or "not-set", base_url=base_url, timeout=timeout)
        logger.info("AI 백엔드: OpenAI 호환 | 주소: %s | 모델: %s", base_url or "OpenAI Cloud", model_name)
    except ImportError:
        logger.error("openai 패키지가 설치되지 않았습니다.")

# 초기화
reload_config()

# ─── 핵심 분석 함수 ──────────────────────────────────────────
def analyze_packet(packet_data: dict) -> dict:
    if not _openai_client and not _gemini_client:
        return _error_response("AI 클라이언트가 설정되지 않았습니다.")

    model_name = _ai_cfg.get("model", "models/gemini-flash-latest")
    
    # 프롬프트 구성
    src_ip, dst_ip = packet_data.get('src', '?'), packet_data.get('dst', '?')
    src_info, dst_info = _get_ip_info(src_ip), _get_ip_info(dst_ip)
    
    system_prompt = (
        "당신은 보안 분석가입니다. 패킷 정보를 분석하여 반드시 아래 JSON 형식으로만 답변하세요.\n"
        "{\"analysis\": \"3문장 요약\", \"risk_level\": \"LOW/MEDIUM/HIGH\", \"tags\": [\"태그\"]}"
    )
    user_prompt = f"출발지: {src_ip}({src_info}), 목적지: {dst_ip}({dst_info}), 프로토콜: {packet_data.get('proto')}, 요약: {packet_data.get('summary')}"

    try:
        # A. Gemini Native 분석
        if _gemini_client:
            from google.genai import types
            response = _gemini_client.models.generate_content(
                model=model_name,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json"
                )
            )
            raw_text = response.text

        # B. OpenAI 호환 분석
        else:
            is_local = bool(_ai_cfg.get("base_url")) and "generativelanguage" not in str(_ai_cfg.get("base_url")).lower()
            resp = _openai_client.chat.completions.create(
                model=model_name,
                messages=[{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
                response_format={"type": "json_object"} if not is_local else None,
                temperature=0.2
            )
            raw_text = resp.choices[0].message.content

        # 파싱 및 응답
        result = _parse_json_safe(raw_text)
        risk = result.get("risk_level", "LOW").upper()
        return {
            "success": True,
            "analysis": result.get("analysis", raw_text),
            "risk_level": risk,
            "risk_color": {"LOW": "#3ecf8e", "MEDIUM": "#f6a623", "HIGH": "#ff6b6b"}.get(risk, "#8888a8"),
            "tags": result.get("tags", []),
            "error": None
        }

    except Exception as e:
        logger.error("AI 분석 실패: %s", e)
        return _error_response(str(e))


def analyze_packets_batch(packets: list) -> dict:
    """
    여러 패킷을 한 번의 AI 호출로 종합 분석합니다.
    packets: 최대 20개 패킷 데이터 목록
    Returns: { success, summary, risk_level, risk_color, patterns, recommendations, error }
    """
    if not _openai_client and not _gemini_client:
        return _error_response("AI 클라이언트가 설정되지 않았습니다.")

    packets = packets[:20]
    model_name = _ai_cfg.get("model", "models/gemini-flash-latest")

    rows = []
    for i, p in enumerate(packets, 1):
        rows.append(
            f"{i}. [{p.get('direction','?')}] {p.get('src','?')} -> {p.get('dst','?')} "
            f"| {p.get('proto','?')} | {p.get('len','?')}B | {p.get('summary','?')}"
        )
    packet_list_str = "\n".join(rows)

    system_prompt = (
        "당신은 보안 분석가입니다. 여러 패킷의 흐름을 종합 분석하여 "
        "반드시 아래 JSON 형식으로만 답변하세요.\n"
        "{\"summary\": \"전체 트래픽 흐름 요약 (3~5문장)\", "
        "\"risk_level\": \"LOW\" | \"MEDIUM\" | \"HIGH\", "
        "\"patterns\": [\"감지된 패턴1\", \"패턴2\"], "
        "\"recommendations\": \"보안 권고사항\"}"
    )
    user_prompt = f"아래 {len(packets)}개의 패킷을 종합 분석해 주세요:\n\n{packet_list_str}"

    try:
        if _gemini_client:
            from google.genai import types
            response = _gemini_client.models.generate_content(
                model=model_name,
                contents=user_prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json"
                )
            )
            raw_text = response.text
        else:
            is_local = bool(_ai_cfg.get("base_url")) and "generativelanguage" not in str(_ai_cfg.get("base_url")).lower()
            resp = _openai_client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"} if not is_local else None,
                temperature=0.2
            )
            raw_text = resp.choices[0].message.content

        result = _parse_json_safe(raw_text)
        risk = result.get("risk_level", "LOW").upper()
        return {
            "success": True,
            "summary": result.get("summary", raw_text),
            "risk_level": risk,
            "risk_color": {"LOW": "#3ecf8e", "MEDIUM": "#f6a623", "HIGH": "#ff6b6b"}.get(risk, "#8888a8"),
            "patterns": result.get("patterns", []),
            "recommendations": result.get("recommendations", ""),
            "packet_count": len(packets),
            "error": None
        }

    except Exception as e:
        logger.error("배치 AI 분석 실패: %s", e)
        return _error_response(str(e))

# ─── 내부 유틸리티 ──────────────────────────────────────────
def _parse_json_safe(text: str) -> dict:
    text = re.sub(r'//.*?\n', '\n', text).strip()
    try: return json.loads(text)
    except: pass
    match = re.search(r'(\{[\s\S]*\})', text)
    if match:
        try: return json.loads(match.group(1))
        except: pass
    return {"analysis": text}

def _get_ip_info(ip: str) -> str:
    if not ip or ip == '?': return ""
    try:
        if ipaddress.ip_address(ip).is_private: return "내부망"
        with urllib.request.urlopen(f"http://ip-api.com/json/{ip}?lang=ko", timeout=1.0) as r:
            d = json.loads(r.read().decode())
            return f"{d.get('country','')}, {d.get('org','')}" if d.get('status') == 'success' else ""
    except: return ""

def _error_response(msg: str) -> dict:
    return {"success": False, "analysis": "", "risk_level": "UNKNOWN", "risk_color": "#8888a8", "tags": [], "error": msg}

def get_status() -> dict:
    return {
        "configured": bool(_ai_cfg.get("api_key")),
        "model": _ai_cfg.get("model", ""),
        "backend": "Gemini Native" if _gemini_client else ("OpenAI" if _openai_client else "None"),
        "base_url": _ai_cfg.get("base_url", "(Native)")
    }

def get_config(): return _config
