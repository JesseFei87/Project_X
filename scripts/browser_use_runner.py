import asyncio
import json
import os
import re
import sys
from pathlib import Path
from typing import Optional


ROOT = Path(__file__).resolve().parents[1]
BROWSER_USE_HOME = ROOT / ".browser-use"


os.environ.setdefault("BROWSER_USE_CONFIG_DIR", str(BROWSER_USE_HOME / "config"))
os.environ.setdefault("XDG_CACHE_HOME", str(BROWSER_USE_HOME / "cache"))


def load_dotenv_file() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def read_task() -> dict:
    if len(sys.argv) < 2:
        raise RuntimeError("Usage: browser_use_runner.py <case-json-file>")
    case_path = Path(sys.argv[1])
    return json.loads(case_path.read_text(encoding="utf-8"))


def write_result(path: Optional[str], payload: dict) -> None:
    if path:
        Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_llm():
    try:
        from browser_use import ChatOpenAI
    except Exception:
        from browser_use.llm import ChatOpenAI
    from browser_use.llm.views import ChatInvokeCompletion

    api_key = os.getenv("BROWSER_USE_API_KEY") or os.getenv("MINIMAX_API_KEY")
    model = os.getenv("BROWSER_USE_MODEL") or os.getenv("MINIMAX_MODEL") or "minimax-m3"
    base_url = os.getenv("BROWSER_USE_BASE_URL") or os.getenv("MINIMAX_BASE_URL")

    if not api_key:
        raise RuntimeError("Missing BROWSER_USE_API_KEY or MINIMAX_API_KEY in .env")
    if not base_url:
        raise RuntimeError("Missing BROWSER_USE_BASE_URL or MINIMAX_BASE_URL in .env")

    class MiniMaxBrowserUseChatOpenAI(ChatOpenAI):
        async def ainvoke(self, messages, output_format=None, **kwargs):
            if output_format is None:
                return await super().ainvoke(messages, output_format=None, **kwargs)

            raw = await super().ainvoke(messages, output_format=None, **kwargs)
            content = extract_json_text(strip_thinking_text(raw.completion))
            parsed = output_format.model_validate_json(content)
            return ChatInvokeCompletion(
                completion=parsed,
                usage=raw.usage,
                stop_reason=raw.stop_reason,
                stop_details=raw.stop_details,
            )

    return MiniMaxBrowserUseChatOpenAI(model=model, api_key=api_key, base_url=base_url, timeout=60)


def strip_thinking_text(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def extract_json_text(text: str) -> str:
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("MiniMax response did not contain a JSON object.")
    return text[start : end + 1]


def serialize_history(history):
    result = {"raw": str(history)}
    for method_name in ("final_result", "is_done", "errors", "urls", "action_names"):
        method = getattr(history, method_name, None)
        if callable(method):
            try:
                result[method_name] = method()
            except Exception as error:
                result[f"{method_name}_error"] = str(error)
    return result


def history_is_successful(history) -> bool:
    is_done = getattr(history, "is_done", None)
    if callable(is_done):
        return bool(is_done())
    return False


def browser_use_max_steps() -> int:
    raw_value = os.getenv("BROWSER_USE_MAX_STEPS", "").strip()
    return int(raw_value) if raw_value else 500


def env_bool(name: str, default: bool) -> bool:
    raw_value = os.getenv(name, "").strip().lower()
    values = {"1": True, "true": True, "yes": True, "on": True, "0": False, "false": False, "no": False, "off": False}
    return values.get(raw_value, default)


async def main() -> None:
    result_file = os.getenv("BROWSER_USE_RESULT_FILE")
    try:
        if sys.version_info < (3, 11):
            raise RuntimeError(
                f"Browser Use requires a newer Python runtime. Current Python is {sys.version.split()[0]}; "
                "install Python 3.11+ or 3.12, then install requirements-browser-use.txt."
            )

        load_dotenv_file()
        task = read_task()
        goal = task.get("goal") or task.get("caseText")
        if not goal:
            raise RuntimeError("Browser Use task file missing goal")

        try:
            from browser_use import Agent, BrowserProfile
        except ModuleNotFoundError as error:
            raise RuntimeError(
                "browser-use is not installed. Install it with: "
                "python3 -m pip install -r requirements-browser-use.txt"
            ) from error

        llm = build_llm()
        browser_profile = BrowserProfile(
            headless=env_bool("BROWSER_USE_HEADLESS", True),
            enable_default_extensions=env_bool("BROWSER_USE_ENABLE_DEFAULT_EXTENSIONS", False),
        )
        agent = Agent(
            task=goal,
            llm=llm,
            browser_profile=browser_profile,
            use_vision=env_bool("BROWSER_USE_VISION", False),
        )
        history = await agent.run(max_steps=browser_use_max_steps())
        payload = {
            "ok": history_is_successful(history),
            "mode": "browser-use",
            "goal": goal,
            "history": serialize_history(history),
        }
        write_result(result_file, payload)
    except Exception as error:
        payload = {
            "ok": False,
            "mode": "browser-use",
            "error": str(error),
        }
        write_result(result_file, payload)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
