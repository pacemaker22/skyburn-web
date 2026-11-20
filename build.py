# Skyburn Phase 0 - Build script (Task 0.1).
# - Inlines nothing external: shaders are already GLSL-as-strings inside the bundle (PRD Part B).
# - Minifies all JS with a conservative, syntax-preserving scanner (comments + indentation).
# - Emits dist/ (index.html with prod flag + minified sources, same relative module paths).
# - Enforces the Phase 0 acceptance criterion: dist/ under 2 MB.
# - Compiles src/wasm/vec3.c -> src/wasm/vec3.wasm when a wasm32-capable clang exists and
#   arms the wasm fetch in the dist copy of vec3.js; otherwise vec3.js never fetches the
#   missing artifact (no 404 noise) and silently uses its JS fallback with the same API.
# - Rejects forbidden framework imports (PRD: no React/Vue/Three.js/Babylon/engine).

import hashlib
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
DIST = os.path.join(ROOT, 'dist')
MAX_DIST_BYTES = 2 * 1000 * 1000  # Phase 0 AC: dist < 2 MB

FORBIDDEN = ('react', 'vue', 'three', 'babylon', 'phaser', 'pixi', 'playcanvas')


def minify_js(source):
    """Conservative JS minifier: strips comments, trailing spaces and blank lines while
    preserving string/template/regex-free syntax byte-for-byte otherwise (ASI-safe)."""
    out = []
    i = 0
    n = len(source)
    state = 'code'  # code | line_comment | block_comment | single | double | template
    template_depth = 0
    interp_stack = []  # brace depth per ${ inside template
    brace_depth = 0
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ''
        if state == 'code':
            if ch == '/' and nxt == '/':
                state = 'line_comment'
                i += 2
                continue
            if ch == '/' and nxt == '*':
                state = 'block_comment'
                i += 2
                continue
            if ch == "'":
                state = 'single'
                out.append(ch)
                i += 1
                continue
            if ch == '"':
                state = 'double'
                out.append(ch)
                i += 1
                continue
            if ch == '`':
                state = 'template'
                out.append(ch)
                i += 1
                continue
            if ch == '{':
                brace_depth += 1
                out.append(ch)
                i += 1
                continue
            if ch == '}':
                if interp_stack and interp_stack[-1] == brace_depth:
                    interp_stack.pop()
                    state = 'template'
                else:
                    brace_depth -= 1
                out.append(ch)
                i += 1
                continue
            # drop leading indentation on each line
            if ch in ' \t' and (not out or out[-1] == '\n'):
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if state == 'line_comment':
            if ch == '\n':
                state = 'code'
                out.append(ch)
            i += 1
            continue
        if state == 'block_comment':
            if ch == '*' and nxt == '/':
                state = 'code'
                i += 2
                continue
            i += 1
            continue
        if state in ('single', 'double'):
            out.append(ch)
            if ch == '\\' and i + 1 < n:
                out.append(nxt)
                i += 2
                continue
            if (state == 'single' and ch == "'") or (state == 'double' and ch == '"'):
                state = 'code'
            i += 1
            continue
        # template literal: preserve content verbatim (GLSL lives here)
        out.append(ch)
        if ch == '\\' and i + 1 < n:
            out.append(nxt)
            i += 2
            continue
        if ch == '`' and template_depth == 0:
            state = 'code'
            i += 1
            continue
        if ch == '$' and nxt == '{':
            out.append('{')
            template_depth += 1
            interp_stack.append(brace_depth)
            brace_depth += 1
            state = 'code'
            i += 2
            continue
        if ch == '`' and template_depth > 0:
            template_depth -= 1
            i += 1
            continue
        i += 1
    text = ''.join(out)
    # collapse runs of blank lines
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text


def check_forbidden_imports(path, source):
    for m in re.finditer(r'''(?:from\s*|require\()\s*['"]([^'"]+)['"]''', source):
        spec = m.group(1).lower()
        for bad in FORBIDDEN:
            if bad in spec:
                raise SystemExit('FORBIDDEN import in %s: %s' % (path, m.group(1)))


def compile_wasm_if_possible():
    """Compile src/wasm/vec3.c with a wasm32-capable clang if available (Task 0.7)."""
    clangs = ['clang', 'clang-18', 'clang-17', 'clang-16']
    c_path = os.path.join(ROOT, 'src', 'wasm', 'vec3.c')
    wasm_path = os.path.join(ROOT, 'src', 'wasm', 'vec3.wasm')
    for clang in clangs:
        try:
            subprocess.run([clang, '--version'], capture_output=True, check=True)
        except (OSError, subprocess.CalledProcessError):
            continue
        cmd = [clang, '--target=wasm32', '-O2', '-nostdlib',
               '-Wl,--no-entry', '-Wl,--export-all',
               '-o', wasm_path, c_path]
        try:
            subprocess.run(cmd, check=True, capture_output=True)
            print('[build] compiled src/wasm/vec3.wasm with %s' % clang)
            return True
        except (OSError, subprocess.CalledProcessError) as e:
            print('[build] clang found but wasm32 build failed; using JS fallback (%s)' % e)
            return False
    print('[build] no wasm32 toolchain found; src/wasm/vec3.js uses the JS fallback (Task 0.7)')
    return False


def main():
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(os.path.join(DIST, 'src'), exist_ok=True)

    compiled = compile_wasm_if_possible()

    total = 0
    files_out = []
    # index.html with prod flag
    with open(os.path.join(ROOT, 'index.html'), 'r', encoding='utf-8') as f:
        html = f.read()
    html = html.replace('<script>window.__SKYBURN_DEV__ = true;</script>',
                        '<script>window.__SKYBURN_DEV__ = false;</script>')
    out_html = os.path.join(DIST, 'index.html')
    with open(out_html, 'w', encoding='utf-8') as f:
        f.write(html)
    files_out.append(('index.html', os.path.getsize(out_html)))

    # Phase 5 (Task 5.1 + 5.4): PWA artifacts - manifest + generated icons, verbatim.
    pwa_files = []
    manifest_src = os.path.join(ROOT, 'manifest.json')
    if os.path.isfile(manifest_src):
        shutil.copyfile(manifest_src, os.path.join(DIST, 'manifest.json'))
        pwa_files.append('manifest.json')
    icons_src = os.path.join(ROOT, 'icons')
    if os.path.isdir(icons_src):
        icons_dist = os.path.join(DIST, 'icons')
        os.makedirs(icons_dist, exist_ok=True)
        for name in sorted(os.listdir(icons_src)):
            if name.endswith('.png'):
                shutil.copyfile(os.path.join(icons_src, name),
                                os.path.join(icons_dist, name))
                pwa_files.append('icons/' + name)

    # walk src/
    for dirpath, _dirnames, filenames in os.walk(SRC):
        rel_dir = os.path.relpath(dirpath, ROOT)
        dest_dir = os.path.join(DIST, rel_dir)
        os.makedirs(dest_dir, exist_ok=True)
        for name in sorted(filenames):
            src_path = os.path.join(dirpath, name)
            rel_path = os.path.relpath(src_path, ROOT)
            dest_path = os.path.join(DIST, rel_path)
            if name.endswith('.js'):
                with open(src_path, 'r', encoding='utf-8') as f:
                    src = f.read()
                check_forbidden_imports(rel_path, src)
                mini = minify_js(src)
                # Arm the wasm fetch in the dist copy ONLY when the artifact really exists:
                # the source tree keeps VEC3_WASM_AVAILABLE = false, so dev serving (raw src,
                # no compiled vec3.wasm) performs zero fetch attempts and never logs a 404.
                if compiled and rel_path == os.path.join('src', 'wasm', 'vec3.js'):
                    armed = mini.replace('VEC3_WASM_AVAILABLE = false',
                                         'VEC3_WASM_AVAILABLE = true')
                    if armed != mini:
                        mini = armed
                        print('[build] armed wasm load in dist/src/wasm/vec3.js')
                    else:
                        print('[build] WARNING: VEC3_WASM_AVAILABLE gate not found in'
                              ' dist/src/wasm/vec3.js; dist stays on the JS fallback')
                with open(dest_path, 'w', encoding='utf-8') as f:
                    f.write(mini)
                files_out.append((rel_path, os.path.getsize(dest_path)))
            elif name.endswith('.json'):
                shutil.copyfile(src_path, dest_path)
                files_out.append((rel_path, os.path.getsize(dest_path)))
            elif name.endswith('.wasm'):
                shutil.copyfile(src_path, dest_path)
                files_out.append((rel_path, os.path.getsize(dest_path)))

    # Phase 5 (Task 5.1 + 5.4): emit dist/sw.js with the FULL dist precache list and a
    # content-hashed cache namespace - every deploy starts a fresh cache (no stale
    # assets) and "offline after first visit" covers the whole bundle, not just the
    # shell. The source-tree sw.js keeps its dev shell list for raw-src serving.
    with open(os.path.join(ROOT, 'sw.js'), 'r', encoding='utf-8') as f:
        sw_src = f.read()
    urls = ["'./'"] + ["'./%s'" % rel.replace(os.sep, '/') for rel, _s in files_out] + \
        ["'./%s'" % rel for rel in pwa_files]
    sw_out = re.sub(r'const PRECACHE_LIST = \[.*?\];',
                    'const PRECACHE_LIST = [\n  ' + ',\n  '.join(urls) + ',\n];',
                    sw_src, count=1, flags=re.S)
    digest = hashlib.sha1('\n'.join(urls).encode('utf-8')).hexdigest()[:8]
    sw_out = sw_out.replace("const VERSION = 'v1-dev';",
                            "const VERSION = 'v1-%s';" % digest)
    out_sw = os.path.join(DIST, 'sw.js')
    with open(out_sw, 'w', encoding='utf-8') as f:
        f.write(sw_out)
    files_out.append(('sw.js', os.path.getsize(out_sw)))

    total = sum(size for _p, size in files_out)
    print('[build] dist/ contents:')
    for path, size in sorted(files_out):
        print('  %-44s %8d B' % (path, size))
    print('[build] total: %d bytes (%.2f MB)' % (total, total / 1e6))
    print('[build] wasm backend: %s' % ('vec3.wasm (dist fetch armed)' if compiled
                                        else 'JS fallback (no fetch attempt, no 404)'))
    if total > MAX_DIST_BYTES:
        raise SystemExit('[build] FAIL: dist/ is %d bytes, Phase 0 limit is %d bytes'
                         % (total, MAX_DIST_BYTES))
    print('[build] OK: dist/ under %d MB limit' % (MAX_DIST_BYTES // 1000000))
    print('[build] Phase 5 AC: dist %.2f MB < 50 MB ship limit' % (total / 1e6))


if __name__ == '__main__':
    main()
