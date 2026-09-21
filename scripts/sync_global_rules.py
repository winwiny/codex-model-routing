#!/usr/bin/env python3
"""Preview or safely install the managed global model-routing rules block."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RULES_PATH = ROOT / 'assets' / 'global-routing.md'
BEGIN = '<!-- model-task-routing:begin -->'
END = '<!-- model-task-routing:end -->'
MANUAL_HEADINGS = (
    '## Codex / Jev / 代码分工',
    '## 每轮 Jev 记录与低置信度处理',
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_info(data: bytes | None) -> dict[str, Any]:
    if data is None:
        return {'exists': False, 'sha256': None, 'size': 0}
    return {'exists': True, 'sha256': digest(data), 'size': len(data)}


def result(status: str, path: Path | None = None, **extra: Any) -> dict[str, Any]:
    output: dict[str, Any] = {'status': status}
    if path is not None:
        output['path'] = str(path)
    output.update(extra)
    return output


def read_regular(path: Path) -> bytes | None:
    if path.is_symlink():
        raise ValueError('symlink_target_refused')
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError('target_not_regular_file')
    return path.read_bytes()


def rules_block() -> str:
    try:
        raw = RULES_PATH.read_bytes()
    except FileNotFoundError as exc:
        raise ValueError('rules_source_missing') from exc
    if RULES_PATH.is_symlink():
        raise ValueError('rules_source_symlink_refused')
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise ValueError('rules_source_not_utf8') from exc
    if text.count(BEGIN) != 1 or text.count(END) != 1 or text.index(BEGIN) > text.index(END):
        raise ValueError('rules_source_marker_invalid')
    return text


def line_ending(text: str) -> str:
    return '\r\n' if '\r\n' in text else '\n'


def adapt_block(block: str, ending: str) -> str:
    normalized = block.replace('\r\n', '\n').replace('\r', '\n')
    return normalized.replace('\n', ending)


def contains_manual_section(text: str) -> bool:
    return any(re.search(r'(?m)^' + re.escape(heading) + r'[ \t]*\r?$', text) for heading in MANUAL_HEADINGS)


def merge_rules(old: bytes | None, block: str) -> bytes:
    if old is None:
        return block.encode('utf-8')
    bom = b'\xef\xbb\xbf' if old.startswith(b'\xef\xbb\xbf') else b''
    try:
        text = old[len(bom):].decode('utf-8')
    except UnicodeDecodeError as exc:
        raise ValueError('target_not_utf8') from exc
    begins, ends = text.count(BEGIN), text.count(END)
    if begins != ends or begins > 1 or begins == 0 and ends != 0:
        raise ValueError('managed_marker_corrupt')
    if begins == 0:
        if contains_manual_section(text):
            raise ValueError('unmanaged_rules_needs_merge')
        ending = line_ending(text)
        replacement = adapt_block(block, ending)
        separator = '' if not text or text.endswith(('\n', '\r')) else ending
        return bom + (text + separator + replacement).encode('utf-8')
    if text.index(BEGIN) > text.index(END):
        raise ValueError('managed_marker_corrupt')
    start = text.index(BEGIN)
    begin_end = start + len(BEGIN)
    end_start = text.index(END, start)
    end = end_start + len(END)
    # Require markers to be whole lines so prose containing a marker cannot be rewritten.
    if ((start and text[start - 1] != '\n')
            or (begin_end < len(text) and text[begin_end] not in '\r\n')
            or (begin_end + 1 < len(text) and text[begin_end] == '\r' and text[begin_end + 1] != '\n')
            or (end_start and text[end_start - 1] != '\n')
            or (end < len(text) and text[end] not in '\r\n')):
        raise ValueError('managed_marker_corrupt')
    if end < len(text) and text[end:end + 2] == '\r\n':
        end += 2
    elif end < len(text) and text[end:end + 1] == '\n':
        end += 1
    ending = line_ending(text)
    replacement = adapt_block(block, ending)
    return bom + (text[:start] + replacement + text[end:]).encode('utf-8')


def select_target(args: argparse.Namespace, env: dict[str, str]) -> tuple[Path | None, str | None]:
    user_home = Path(args.user_home).expanduser() if args.user_home else Path.home()
    if args.client == 'codex':
        codex_home = Path(args.codex_home).expanduser() if args.codex_home else Path(env['CODEX_HOME']).expanduser() if env.get('CODEX_HOME') else user_home / '.codex'
        override = codex_home / 'AGENTS.override.md'
        try:
            override_data = read_regular(override)
            override_nonempty = bool(override_data and override_data.decode('utf-8-sig').strip())
        except ValueError as exc:
            return override, str(exc)
        except UnicodeDecodeError:
            return override, 'target_not_utf8'
        return (override if override_nonempty else codex_home / 'AGENTS.md'), None
    if args.client == 'antigravity':
        return user_home / '.gemini' / 'GEMINI.md', None
    if not args.agent_core:
        return None, 'needs_agent_path'
    candidate = Path(args.agent_core)
    if not candidate.is_absolute() or candidate.name != 'agent-core' or not candidate.is_dir():
        return candidate, 'invalid_agent_path'
    target = candidate / 'AGENTS.md'
    if not target.exists():
        return target, 'invalid_agent_path'
    return target, None


def safe_write(path: Path, old: bytes | None, new: bytes) -> tuple[str | None, str | None]:
    if path.is_symlink():
        raise ValueError('symlink_target_refused')
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    if old is not None:
        backup = parent / (path.name + '.backup.' + uuid.uuid4().hex)
        with open(backup, 'xb') as handle:
            handle.write(old)
        if backup.read_bytes() != old:
            raise ValueError('backup_verification_failed')
        backup_hash = digest(old)
    else:
        backup = None
        backup_hash = None
    fd, temp_name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(new)
            handle.flush()
            os.fsync(handle.fileno())
        if old is not None:
            os.chmod(temp, stat.S_IMODE(path.stat().st_mode))
        # This narrows the race window; it is not a cross-process lock.
        if read_regular(path) != old:
            raise ValueError('target_changed_before_replace')
        os.replace(temp, path)
        if read_regular(path) != new:
            raise ValueError('write_verification_failed')
    finally:
        if temp.exists():
            temp.unlink()
    return (str(backup) if backup else None, backup_hash)


def export_template(path: Path, block: bytes) -> dict[str, Any]:
    try:
        old = read_regular(path)
    except ValueError as exc:
        return result(str(exc), path)
    if old is not None:
        if old == block:
            return result('nochange', path, **file_info(old), artifact_only=True)
        return result('export_exists_different', path, **file_info(old), artifact_only=True)
    if not path.parent.exists():
        return result('export_parent_missing', path, artifact_only=True)
    try:
        with open(path, 'xb') as handle:
            handle.write(block)
            handle.flush()
            os.fsync(handle.fileno())
        if read_regular(path) != block:
            return result('export_verification_failed', path, artifact_only=True)
    except FileExistsError:
        current = read_regular(path)
        return result('nochange' if current == block else 'export_exists_different', path, **file_info(current), artifact_only=True)
    except (OSError, ValueError) as exc:
        return result(str(exc), path, artifact_only=True)
    return result('exported', path, **file_info(block), artifact_only=True)


def run(argv: list[str] | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--client', choices=('codex', 'antigravity', 'accio-work'), default='codex')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--codex-home')
    parser.add_argument('--user-home')
    parser.add_argument('--agent-core')
    parser.add_argument('--export')
    args = parser.parse_args(argv)
    env = dict(os.environ if env is None else env)
    try:
        block = rules_block()
    except ValueError as exc:
        return result(str(exc))
    block_bytes = block.encode('utf-8')
    if args.export:
        return export_template(Path(args.export), block_bytes)
    target, target_error = select_target(args, env)
    if target_error:
        return result(target_error, target)
    assert target is not None
    try:
        old = read_regular(target)
        new = merge_rules(old, block)
    except ValueError as exc:
        return result(str(exc), target)
    if args.client == 'antigravity' and len(new.decode('utf-8-sig')) > 12000:
        return result('antigravity_size_limit', target, before=file_info(old), after=file_info(new))
    if args.client == 'codex' and len(new) >= 32 * 1024:
        return result('codex_size_needs_manual_budget_check', target, before=file_info(old), after=file_info(new))
    changed = old != new
    if not args.apply or not changed:
        return result('preview' if changed else 'nochange', target, before=file_info(old), after=file_info(new), would_change=changed)
    try:
        backup_path, backup_hash = safe_write(target, old, new)
    except ValueError as exc:
        return result(str(exc), target, before=file_info(old), after=file_info(new))
    return result('applied', target, before=file_info(old), after=file_info(new), backup_path=backup_path, backup_sha256=backup_hash)


def main() -> int:
    try:
        output = run()
    except OSError:
        output = result('os_error')
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0 if output['status'] in {'preview', 'nochange', 'applied', 'exported'} else 1


if __name__ == '__main__':
    raise SystemExit(main())
