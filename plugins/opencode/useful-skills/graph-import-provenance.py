"""Find exact JavaScript dynamic imports and inert regex-import text."""

import json
import re
import sys
from pathlib import Path

from tree_sitter import Language, Parser

MAX_SOURCE_BYTES = 8 * 1024 * 1024


def parser_for(source_path: Path) -> Parser:
    suffix = source_path.suffix.lower()

    if suffix == ".tsx" or suffix in (".ts", ".mts", ".cts"):
        import tree_sitter_typescript as ts

        language_factory = ts.language_tsx if suffix == ".tsx" else ts.language_typescript
        return Parser(Language(language_factory()))

    import tree_sitter_javascript as ts

    return Parser(Language(ts.language()))


def is_dynamic_import(node, source: bytes) -> bool:
    if node.type != "call_expression":
        return False

    callee = node.child_by_field_name("function")
    if callee is None and node.children:
        first = node.children[0]
        if source[first.start_byte:first.end_byte] == b"import":
            callee = first

    arguments = node.child_by_field_name("arguments")
    return callee is not None and arguments is not None and source[callee.start_byte:callee.end_byte] == b"import"


def static_import_argument(value_node, source: bytes) -> str | None:
    literal = source[value_node.start_byte:value_node.end_byte]

    if value_node.type == "string":
        if len(literal) < 2 or literal[:1] not in (b"'", b'"') or literal[-1:] != literal[:1]:
            return None

        value = literal[1:-1]
        if b"\\" in value or b"\n" in value or b"\r" in value:
            return None
    elif value_node.type == "template_string":
        if len(literal) < 2 or literal[:1] != b"`" or literal[-1:] != b"`":
            return None

        if any(child.type == "template_substitution" for child in value_node.named_children):
            return None

        value = literal[1:-1]
        if b"\\" in value or b"\n" in value or b"\r" in value:
            return None
    else:
        return None

    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return None


def inert_markers(source: bytes, specifier: str) -> list[tuple[int, int]]:
    encoded = specifier.encode("utf-8")
    pattern = re.compile(rb"import\(\s*(['\"])" + re.escape(encoded) + rb"\1\s*\)")
    return [(match.start(), match.end()) for match in pattern.finditer(source)]


def import_may_target_local(source_path: Path, specifier: str, target_path: str) -> bool:
    if specifier.startswith(("./", "../")):
        if "\\" in specifier or "?" in specifier or "#" in specifier:
            return True

        if not Path(specifier).suffix:
            return True

        try:
            resolved_import = (source_path.parent / specifier).resolve(strict=False)
            resolved_target = Path(target_path).resolve(strict=False)
        except (OSError, RuntimeError):
            return True

        return resolved_import == resolved_target

    if specifier.startswith(("http://", "https://", "node:", "data:")):
        return False

    return True


def inspect_source(source_file: str, source_path: Path, targets: set[str], inert_targets: dict[str, str]) -> dict:
    try:
        with source_path.open("rb") as source_stream:
            source = source_stream.read(MAX_SOURCE_BYTES + 1)
    except OSError:
        return {"ok": False, "error": "source-unreadable"}

    if len(source) > MAX_SOURCE_BYTES:
        return {"ok": False, "error": "source-too-large"}

    possible_targets = {url for url in targets if url.encode("utf-8") in source}
    possible_inert = {specifier for specifier in inert_targets if inert_markers(source, specifier)}
    if not possible_targets and not possible_inert:
        return {"ok": True, "witnesses": [], "inertMatches": []}

    try:
        root = parser_for(source_path).parse(source).root_node
    except Exception:
        return {"ok": False, "error": "parser-failed"}

    if root.has_error:
        return {"ok": False, "error": "syntax-error"}

    witnesses = []
    safe_ranges = []
    dynamic_imports = []
    stack = [root]

    while stack:
        node = stack.pop()
        if node.type in ("comment", "string", "string_fragment", "template_chars"):
            safe_ranges.append((node.start_byte, node.end_byte))

        if is_dynamic_import(node, source):
            arguments = node.child_by_field_name("arguments")
            values = [child for child in arguments.named_children if child.type != "comment"]
            dynamic_imports.append((node, values))

            if len(values) == 1 and values[0].type == "string":
                url = static_import_argument(values[0], source)
                if url in possible_targets:
                    witnesses.append({
                        "sourceFile": source_file,
                        "url": url,
                        "sourceLocation": f"L{node.start_point.row + 1}",
                    })

        stack.extend(reversed(node.children))

    inert_matches = []
    for specifier in possible_inert:
        markers = inert_markers(source, specifier)
        if not markers or not all(
            any(start <= marker_start and marker_end <= end for start, end in safe_ranges)
            for marker_start, marker_end in markers
        ):
            continue

        imports_are_unambiguous = True
        for _node, values in dynamic_imports:
            if len(values) != 1:
                imports_are_unambiguous = False
                break

            imported = static_import_argument(values[0], source)
            if imported is None or import_may_target_local(source_path, imported, inert_targets[specifier]):
                imports_are_unambiguous = False
                break

        if imports_are_unambiguous:
            inert_matches.append({"sourceFile": source_file, "specifier": specifier})

    return {"ok": True, "witnesses": witnesses, "inertMatches": inert_matches}


def inspect_sources(request: dict) -> dict:
    witnesses = []
    inert_matches = []
    targets = set(request["targets"])
    inert_targets = {}

    for target in request.get("inertTargets", []):
        inert_targets.setdefault(target["sourceFile"], {})[target["specifier"]] = target["targetPath"]

    for source in request["sources"]:
        result = inspect_source(
            source["sourceFile"],
            Path(source["path"]),
            targets,
            inert_targets.get(source["sourceFile"], {}),
        )
        if not result["ok"]:
            return result

        witnesses.extend(result["witnesses"])
        inert_matches.extend(result["inertMatches"])

    return {"ok": True, "witnesses": witnesses, "inertMatches": inert_matches}


def main() -> None:
    try:
        request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        result = inspect_sources(request)
    except Exception:
        result = {"ok": False, "error": "invalid-request"}

    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
