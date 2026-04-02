"""
ai_service.py
─────────────
네트워크 패킷 데이터를 AI API로 분석하는 서비스 모듈.

지원하는 백엔드 (config.json 설정으로 전환 가능):
  ① OpenAI Cloud  : api_key: "sk-..."
  ② LM Studio     : base_url: "http://localhost:1234/v1",  api_key: "lm-studio"
  ③ Ollama        : base_url: "http://localhost:11434/v1", api_key: "ollama"
  ④ 기타 OpenAI 호환 서버

필요 패키지:
  pip install openai
"""

import json
import logging
import urllib.request
import ipaddress
from pathlib import Path

logger = logging.getLogger(__name__)


_CONFIG_PATH = Path(__file__).parent / "config.json"

def _load_config() -> dict:
    """config.json 파일을 읽어 딕셔너리로 반환합니다."""
    try:
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning("config.json 파일을 찾을 수 없습니다. 기본값을 사용합니다.")
        return {}
    except json.JSONDecodeError as e:
        logger.error("config.json 파싱 오류: %s. 기본값을 사용합니다.", e)
        return {}

_config = _load_config()
_ai_cfg = _config.get("ai", {})


def _get_ip_info(ip_str: str) -> str:
    """IP의 국가 및 조직 정보를 가져옵니다 (ip-api.com 활용)"""
    if not ip_str or ip_str == '?':
        return ""
    try:
        ip_obj = ipaddress.ip_address(ip_str)
        if ip_obj.is_private or ip_obj.is_loopback:
            return "내부 네트워크 (사설 IP)"
            
        url = f"http://ip-api.com/json/{ip_str}?lang=ko"
        req = urllib.request.Request(url, headers={'User-Agent': 'NetVisor/1.0'})
        with urllib.request.urlopen(req, timeout=1.5) as response:
            data = json.loads(response.read().decode())
            if data.get('status') == 'success':
                country = data.get('country', '')
                org = data.get('org', '') or data.get('isp', '')
                return f"{country}, {org}"
    except Exception:
        pass
    return "조회 불가"


try:
    from openai import OpenAI

    _api_key  = str(_ai_cfg.get("api_key", ""))
    _base_url = str(_ai_cfg.get("base_url", "")).strip() or None
    _timeout  = float(_ai_cfg.get("timeout", 30))

    if not _api_key:
        logger.warning(
            "config.json 에 ai.api_key 가 설정되지 않았습니다. "
            "LM Studio·Ollama 사용 시에는 임의의 값(예: 'lm-studio')을 넣으세요."
        )

    _client_kwargs = {
        "api_key": _api_key or "not-set",
        "timeout": _timeout,
    }
    if _base_url:
        _client_kwargs["base_url"] = _base_url
        logger.info("AI 백엔드: %s (로컬/커스텀)  타임아웃: %.0fs", _base_url, _timeout)
    else:
        logger.info("AI 백엔드: OpenAI Cloud  타임아웃: %.0fs", _timeout)

    _client = OpenAI(**_client_kwargs) if _api_key else None

except ImportError:
    logger.error("openai 패키지가 설치되지 않았습니다. `pip install openai` 를 실행하세요.")
    _client = None



_SYSTEM_PROMPT = (
    "당신은 최고 수준의 네트워크 보안 분석가입니다. "
    "사용자가 제공하는 네트워크 패킷 정보를 바탕으로 "
    "보안 관점의 심층 분석을 한국어로 제공합니다. "
    "답변은 간결하고 전문적이어야 합니다."
)



def analyze_packet(packet_data: dict) -> dict:
    """
    패킷 데이터를 AI로 분석합니다.

    Parameters
    ----------
    packet_data : dict
        app.py 의 packet_callback 이 emit 하는 dict
        (no, time, src, dst, proto, len, summary, direction, raw)

    Returns
    -------
    dict
        {
          "success": bool,
          "analysis": str,        # AI 분석 텍스트
          "risk_level": str,      # "LOW" | "MEDIUM" | "HIGH"
          "risk_color": str,      # CSS 색상값
          "tags": list[str],      # 분류 태그
          "error": str | None
        }
    """
    if _client is None:
        return _error_response("OpenAI 클라이언트가 초기화되지 않았습니다. API 키를 확인하세요.")


    direction_kr = {
        "INBOUND":  "수신 (외부 → 내부)",
        "OUTBOUND": "송신 (내부 → 외부)",
    }.get(packet_data.get("direction", ""), "알 수 없음")


    src_ip = packet_data.get('src', '?')
    dst_ip = packet_data.get('dst', '?')
    src_info = _get_ip_info(src_ip)
    dst_info = _get_ip_info(dst_ip)
    
    src_display = f"{src_ip} ({src_info})" if src_info else src_ip
    dst_display = f"{dst_ip} ({dst_info})" if dst_info else dst_ip

    user_prompt = f"""
## 분석 대상 패킷

| 항목 | 값 |
|------|------|
| 번호 | #{packet_data.get('no', '?')} |
| 출발지 IP | {src_display} |
| 목적지 IP | {dst_display} |
| 프로토콜 | {packet_data.get('proto', '?')} |
| 크기 | {packet_data.get('len', '?')} bytes |
| 방향 | {direction_kr} |
| Scapy 요약 | {packet_data.get('summary', '?')} |

위 패킷을 분석하여 **반드시** 아래 JSON 형식으로만 답변하세요. 다른 텍스트는 포함하지 마세요.

{{
  "analysis": "3~5문장 보안 분석. 패킷 특성, 프로토콜 역할, 보안 위협 여부, 권고사항 포함.",
  "risk_level": "LOW 또는 MEDIUM 또는 HIGH 중 하나",
  "tags": ["태그1", "태그2", "태그3"]  // 최대 4개, 예: ["TCP", "외부 접속", "정상", "포트 스캔 의심"]
}}
"""


    is_local = bool(_base_url)


    disable_thinking = _ai_cfg.get("disable_thinking", True)
    if isinstance(disable_thinking, str):
        disable_thinking = disable_thinking.lower() in ("1", "true", "yes")
    effective_prompt = ("/no_think\n" + user_prompt) if (is_local and disable_thinking) else user_prompt

    _model = str(_ai_cfg.get("model", "gpt-4o-mini"))
    _max_tokens = int(_ai_cfg.get("max_tokens", 600))

    create_kwargs = {
        "model":       _model,
        "messages":    [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user",   "content": effective_prompt},
        ],
        "max_tokens":  _max_tokens,
        "temperature": 0.2,
    }

    if not is_local:
        create_kwargs["response_format"] = {"type": "json_object"}

    try:
        response = _client.chat.completions.create(**create_kwargs)
        raw_text = response.choices[0].message.content.strip()


        import re
        raw_text = re.sub(r'<think>.*?</think>', '', raw_text, flags=re.DOTALL).strip()

        result   = _parse_json_safe(raw_text)

        risk_level = result.get("risk_level", "LOW").upper()
        if risk_level not in ("LOW", "MEDIUM", "HIGH"):
            risk_level = "LOW"

        risk_color = {
            "LOW":    "#3ecf8e",
            "MEDIUM": "#f6a623",
            "HIGH":   "#ff6b6b",
        }.get(risk_level, "#8888a8")

        return {
            "success":    True,
            "analysis":   result.get("analysis", raw_text),
            "risk_level": risk_level,
            "risk_color": risk_color,
            "tags":       result.get("tags", []),
            "error":      None,
        }

    except Exception as e:
        err_str = str(e)

        if any(kw in err_str.lower() for kw in ("timeout", "timed out", "read timeout")):
            logger.error("AI API 타임아웃 (%ss 초과): %s", _timeout, e)
            return _error_response(
                f"⏱ AI 응답 타임아웃 ({int(_timeout)}초 초과).\n"
                "더 작은 모델을 사용하거나 config.json 에서 ai.timeout 값을 늘려보세요."
            )
        logger.error("AI API 호출 실패: %s", e)
        return _error_response(err_str)


def get_status() -> dict:
    """API 키 및 백엔드 설정 상태를 반환합니다."""
    api_key  = str(_ai_cfg.get("api_key", ""))
    base_url = str(_ai_cfg.get("base_url", "")).strip()
    model    = str(_ai_cfg.get("model", "gpt-4o-mini"))


    if not base_url:
        backend = "OpenAI Cloud"
    elif "1234" in base_url:
        backend = "LM Studio"
    elif "11434" in base_url or "ollama" in base_url.lower():
        backend = "Ollama"
    else:
        backend = "Custom"

    return {
        "configured":   bool(api_key),
        "model":        model,
        "backend":      backend,
        "base_url":     base_url or "(OpenAI Cloud)",
        "key_preview":  f"{api_key[:8]}...{api_key[-4:]}" if len(api_key) > 12 else "(미설정)",
    }



def get_config() -> dict:
    """다른 모듈에서 config.json 값을 참조할 때 사용합니다."""
    return _config



def _parse_json_safe(text: str) -> dict:
    """
    LLM 응답에서 JSON 블록을 추출합니다.
    로컬 LLM 은 ```json ... ``` 마크다운 블록으로 감싸거나
    앞뒤에 불필요한 텍스트를 붙이는 경우가 많아 정규식으로 보완합니다.
    """
    import re
    # 1차: 그대로 파싱
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 2차: ```json ... ``` 또는 ``` ... ``` 블록 추출
    match = re.search(r'```(?:json)?\s*({.*?})\s*```', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # 3차: 중괄호로 감싼 첫 번째 JSON 객체 추출
    match = re.search(r'({.*})', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # 실패 시 원문을 analysis 로 반환
    logger.warning("JSON 파싱 실패, 원문을 analysis 로 사용합니다.")
    return {"analysis": text, "risk_level": "LOW", "tags": []}


def _error_response(message: str) -> dict:
    return {
        "success":    False,
        "analysis":   "",
        "risk_level": "UNKNOWN",
        "risk_color": "#8888a8",
        "tags":       [],
        "error":      message,
    }
