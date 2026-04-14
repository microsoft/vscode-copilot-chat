#!/usr/bin/env python3
"""
deepseek-critic.py

Read-only critic hook for VS Code Copilot Chat.
It reads stdin JSON shaped like { "prompt": "..." } and returns a hook-compatible
JSON payload with hookSpecificOutput.additionalContext.

The script is designed to be used in two ways:
1. As a visible workspace artifact under `.copilot/hooks/`
2. As an auto-injected critic lane called by the extension itself
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


PCC_PRESETS = {
    "探": {
        "label": "#探",
        "constraints": [
            "Challenge assumptions and look for specific weaknesses.",
            "Do not be agreeable for its own sake.",
            "Prefer concrete risks over vague criticism.",
            "If something is uncertain, mark it as an assumption.",
        ],
    },
    "極": {
        "label": "#極",
        "constraints": [
            "Be concise and structured.",
            "Answer only what is useful for moving the task forward.",
            "Avoid filler and social niceties.",
        ],
    },
    "均": {
        "label": "#均",
        "constraints": [
            "Balance strengths and weaknesses.",
            "Pair each weakness with one practical improvement.",
        ],
    },
    "監": {
        "label": "#監",
        "constraints": [
            "Judge based on evidence and likely verification needs.",
            "Ignore self-reports of success if they lack support.",
            "Call out missing evidence explicitly.",
        ],
    },
    "刃": {
        "label": "#刃",
        "constraints": [
            "Behave like a strict implementation reviewer.",
            "Prefer concrete change plans over abstract commentary.",
            "Recommend the safest next step with reasons.",
        ],
    },
}


DEFAULT_CONFIG = {
    "enabled": True,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "preset": "刃",
    "baseUrl": "https://api.deepseek.com/chat/completions",
    "keychainService": "deepseek-api",
    "keychainAccount": "default",
    "fallbackKeychainServices": ["deepseek-api", "deepseek", "DeepSeek API"],
    "maxTokens": 900,
    "temperature": 0.2,
    "promptContextChars": 12000,
    "responseChars": 3200,
    "styleNote": "Return critique in Japanese. Be dense, concrete, and useful.",
    "focusAreas": [
        "implementation gaps",
        "missing evidence",
        "next concrete patch",
        "test and verification blind spots",
    ],
}


def load_config() -> dict[str, Any]:
    config_path = Path(__file__).with_name("deepseek-critic.config.json")
    if not config_path.exists():
        return dict(DEFAULT_CONFIG)

    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
        merged = dict(DEFAULT_CONFIG)
        merged.update(data)
        return merged
    except Exception:
        print("DeepSeek critic runtime config JSON is invalid.", file=sys.stderr)
        return dict(DEFAULT_CONFIG)


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {"prompt": raw}


def read_keychain_secret(service: str, account: str | None) -> str | None:
    base = ["security", "find-generic-password", "-w", "-s", service]
    variants = []
    if account:
        variants.append(base + ["-a", account])
    variants.append(base)

    for cmd in variants:
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=4,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                return proc.stdout.strip()
        except Exception:
            continue
    return None


def resolve_api_key(config: dict[str, Any]) -> str | None:
    env_key = os.environ.get("DEEPSEEK_API_KEY")
    if env_key:
        return env_key

    service = config.get("keychainService")
    account = config.get("keychainAccount")
    if isinstance(service, str) and service:
        secret = read_keychain_secret(service, account if isinstance(account, str) else None)
        if secret:
            return secret

    for fallback_service in config.get("fallbackKeychainServices", []):
        if not isinstance(fallback_service, str):
            continue
        secret = read_keychain_secret(fallback_service, account if isinstance(account, str) else None)
        if secret:
            return secret

    return None


def build_messages(data: dict[str, Any], config: dict[str, Any]) -> list[dict[str, str]]:
    preset_name = config.get("preset", "監")
    preset = PCC_PRESETS.get(preset_name, PCC_PRESETS["監"])
    constraints = "\n".join(f"- {item}" for item in preset["constraints"])
    style_note = config.get("styleNote", DEFAULT_CONFIG["styleNote"])
    focus_areas = "\n".join(f"- {item}" for item in config.get("focusAreas", []))
    prompt = str(data.get("prompt", ""))
    active_file = data.get("activeFile")
    workspace_root = data.get("workspaceRoot")

    system_prompt = (
        f"[PCC Protocol: {preset['label']}]\n"
        "You are a read-only critic for another coding agent.\n"
        "You do not implement the task. You only improve the next turn.\n"
        "Constraints:\n"
        f"{constraints}\n"
        f"- {style_note}\n"
        "- Focus on: likely flaws, missing evidence, and the single best next step.\n"
        "- Keep the answer short enough to inject as additional context.\n"
        f"{focus_areas and ('- Extra focus areas:\\n' + focus_areas + '\\n')}"
        "Output format:\n"
        "1. Risks\n"
        "2. Missing evidence\n"
        "3. Next step\n"
        "4. Optional verifier\n"
    )

    context_lines = []
    if isinstance(active_file, str) and active_file:
        context_lines.append(f"Active file: {active_file}")
    if isinstance(workspace_root, str) and workspace_root:
        context_lines.append(f"Workspace root: {workspace_root}")

    context_block = "\n".join(context_lines)
    if context_block:
        context_block = f"Known local context:\n{context_block}\n\n"

    user_prompt = (
        "Review the following Copilot Chat user request as a critic lane.\n"
        "Do not answer the request directly. Produce only critique and next-step guidance.\n\n"
        f"{context_block}"
        f"{prompt[: int(config.get('promptContextChars', DEFAULT_CONFIG['promptContextChars']))]}"
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def call_deepseek(messages: list[dict[str, str]], config: dict[str, Any], api_key: str) -> str | None:
    payload = {
        "model": config.get("model", DEFAULT_CONFIG["model"]),
        "messages": messages,
        "temperature": config.get("temperature", DEFAULT_CONFIG["temperature"]),
        "max_tokens": config.get("maxTokens", DEFAULT_CONFIG["maxTokens"]),
        "stream": False,
    }
    request = urllib.request.Request(
        config.get("baseUrl", DEFAULT_CONFIG["baseUrl"]),
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return f"DeepSeek critic failed with HTTP {exc.code}."
    except Exception:
        return None

    try:
        text = body["choices"][0]["message"]["content"]
    except Exception:
        return None

    if not isinstance(text, str):
        return None
    return text[: int(config.get("responseChars", DEFAULT_CONFIG["responseChars"]))]


def emit(additional_context: str | None) -> int:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
        }
    }
    if additional_context:
        payload["hookSpecificOutput"]["additionalContext"] = additional_context
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def main() -> int:
    config = load_config()
    if not config.get("enabled", True):
        return emit(None)

    data = read_stdin_json()
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return emit(None)

    api_key = resolve_api_key(config)
    if not api_key:
        print("DeepSeek API key missing.", file=sys.stderr)
        return emit(None)

    messages = build_messages(data, config)
    response = call_deepseek(messages, config, api_key)
    if not response:
        print("DeepSeek critic returned no response.", file=sys.stderr)
        return emit(None)

    additional_context = f"[DeepSeek Critic]\n{response.strip()}"
    return emit(additional_context)


if __name__ == "__main__":
    raise SystemExit(main())
