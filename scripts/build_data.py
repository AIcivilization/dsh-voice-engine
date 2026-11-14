#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py — 从三个公开数据源重建 voices.json

用法:
    python3 build_data.py --src <原始素材目录> [--out <输出目录>]

默认:
    --src  ~/WorkBuddy/2026-11-02-21-00-55
    --out  ./data

依赖: pypinyin  (pip3 install --user pypinyin)

设计原则:
    1. 以「发音人编码」为主键，不用名称。名称有别名、有「讯飞」前缀、有前后空格，
       用它做键会漏匹配（历史教训：曾因此把黄金子集算成 97，实际 100）。
    2. 冲突不硬合并，隔离到 meta.conflicts 供人工定性。
    3. 拼音只由标准名生成，不混入风格和场景（否则搜 yuyin 会命中所有「语音助手」）。
"""

import argparse
import collections
import csv
import datetime
import json
import os
import re
import sys

try:
    from pypinyin import lazy_pinyin, Style
except ImportError:
    sys.exit("缺少依赖: pip3 install --user pypinyin")


# ── 常量 ────────────────────────────────────────────────────────────────────

# 语种关键词 → ISO 码。顺序敏感：「巴西葡萄牙语」必须排在「葡萄牙语」之前。
LANG_PATTERNS = [
    ('pt-BR', '巴西葡萄牙语'), ('de', '德语'), ('it', '意大利语'), ('ru', '俄语'),
    ('pt', '葡萄牙语'), ('es', '西班牙语'), ('fr', '法语'), ('ja', '日语'),
    ('ko', '韩语'), ('ar', '阿拉伯语'), ('th', '泰语'), ('vi', '越南语'),
    ('hi', '印地语'), ('tr', '土耳其语'), ('nl', '荷兰语'), ('pl', '波兰语'),
    ('ur', '乌尔都'), ('fa', '波斯语'), ('id', '印尼语'), ('ms', '马来语'),
    ('he', '希伯来语'), ('el', '希腊语'), ('yue', '粤语'), ('sc', '四川话'),
    ('ha', '河南话'), ('db', '东北话'), ('ug', '维吾尔'), ('bo', '藏语'),
    ('mn', '蒙古语'),
]


# 人工定性结论。脚本无法自动判断的冲突，把结论固化在这里，重跑不会丢失。
CONFLICT_RESOLUTIONS = {
    '聆小琬': '样音已归属 x4_lingxiaowan_boy；试听台标「可爱女童/童声」，官方目录标「成年女声」，'
              '属声线标注冲突，以官方为准',
    '七哥': '样音 qige.wav 与已收录条目完全一致，仅场景标注不同，按重复忽略',
    '超哥': '样音 超哥4.wav 与已收录的 超哥.wav 不同，但同名同风格，按重复标注忽略',
}


# ── 工具函数 ────────────────────────────────────────────────────────────────

def norm_name(name):
    """名称归一：去掉「讯飞」前缀和所有空白字符。"""
    return re.sub(r'\s+', '', name or '').replace('讯飞', '')


def pinyin_of(name):
    """返回 (全拼, 首字母)。只由名称生成。"""
    clean = re.sub(r'[^\u4e00-\u9fa5A-Za-z0-9]', '', name or '')
    return (
        ''.join(lazy_pinyin(clean)),
        ''.join(lazy_pinyin(clean, style=Style.FIRST_LETTER)),
    )


def lang_of(*styles):
    """按顺序检查风格串，命中即返回语种码。"""
    for s in styles:
        if not s:
            continue
        for code, word in LANG_PATTERNS:
            if word in s:
                return code
    return None


def dialect_of(rec):
    """方言音色的地区。试听台写的是「四川女声」，不含「四川话」，LANG_PATTERNS 匹配不到。"""
    if rec.get('sceneAlt') != '方言场景' or rec.get('lang') != 'zh':
        return None
    return re.sub(r'[男女]声$', '', rec.get('styleAlt') or '') or None


def clean_scene(scene):
    """对照表里个别场景是脏值，比如「课件文本、阅读场景、阅读场景」。"""
    if scene and '阅读' in scene:
        return '阅读听书'
    return scene


def gender_of(style):
    if '童' in (style or ''):
        return 'child'
    if '女' in (style or ''):
        return 'female'
    if '男' in (style or ''):
        return 'male'
    return 'unknown'


def filename_bases(url):
    """
    从样音 URL 提取可用于匹配的名称候选。

    解决「聆小琬-小男孩.wav」对应音色名「聆小琬-小男孩」、
    而试听台把该条目记作「聆小琬」的错配问题。
    """
    if not url:
        return []
    fn = url.split('/')[-1]
    base = re.sub(r'\.\w+$', '', fn).replace('%20', ' ').strip()
    base = re.sub(r'^\d+[-_]', '', base)          # 去掉「8-」这类序号前缀
    out = [base]
    head = re.split(r'[-_]', base)[0].strip()
    if head and head != base:
        out.append(head)
    return out


# ── 主流程 ──────────────────────────────────────────────────────────────────

def load_sources(src_dir):
    """读取试听台内联数据与对照表。"""
    page = os.path.join(src_dir, '声音引擎试听台.html')
    table = os.path.join(src_dir, '音色对照表.csv')

    html = open(page, encoding='utf-8').read()
    m = re.search(r'const V\s*=\s*(\[.*?\]);', html, re.S)
    if not m:
        sys.exit(f'未能从 {page} 中提取 const V 数据')
    preview = json.loads(m.group(1))

    rows = list(csv.DictReader(open(table, encoding='utf-8-sig')))
    return preview, rows


def build_records(rows):
    """以对照表为骨架，按 code 建主键索引。"""
    records, order, name2key = {}, [], {}

    for r in rows:
        name = (r.get('名称') or '').strip()
        code = (r.get('发音人编码') or '').strip()
        key = code if code else 'name:' + norm_name(name)

        if key in records:                     # 同 code 多行：合并为别名
            continue

        style = (r.get('声线/年龄') or '').strip()
        rec = {
            'code': key,
            'name': name,
            'aliases': [],
            'style': style,
            'gender': gender_of(style),
            'scene': (r.get('分类') or '').strip() or None,
            'sample': (r.get('样音地址') or '').strip() or None,
            'hasCode': bool(code),
            'flags': [],
        }
        if not code:
            rec['flags'].append('no_code')
        if not rec['scene']:
            rec['flags'].append('missing_scene')

        records[key] = rec
        order.append(key)
        name2key.setdefault(norm_name(name), key)

    return records, order, name2key


def merge_preview(records, order, name2key, preview):
    """把试听台的样音、风格、场景并入骨架。"""
    by_name = collections.defaultdict(list)
    by_file = collections.defaultdict(list)
    for v in preview:
        by_name[norm_name(v['n'])].append(v)
        for base in filename_bases(v['u']):
            by_file[norm_name(base)].append(v)

    used = set()
    conflicts = []
    matched_by_file = 0

    def add_conflict(v, existing, note):
        nm = norm_name(v['n'])
        entry = {
            'name': nm,
            'rawName': v['n'].strip(),
            'style': v['s'],
            'scene': v['c'],
            'gender': v['g'],
            'sample': (v['u'] or '').strip() or None,
            'existingCode': existing,
            'existingSample': records[existing]['sample'] if existing else None,
            'note': note,
        }
        if nm in CONFLICT_RESOLUTIONS:
            entry['resolved'] = True
            entry['resolution'] = CONFLICT_RESOLUTIONS[nm]
        conflicts.append(entry)

    for key in order:
        rec = records[key]

        # 匹配优先级：归一名称 → 别名 → 样音文件名
        cand = by_name.get(norm_name(rec['name'])) or []
        if not cand:
            for alias in rec['aliases']:
                cand = by_name.get(norm_name(alias)) or []
                if cand:
                    break
        if not cand:
            cand = by_file.get(norm_name(rec['name'])) or []
            if cand:
                matched_by_file += 1
        if not cand:
            continue

        if len(cand) == 1:
            v = cand[0]
            if not rec['sample'] and v['u'].strip():
                rec['sample'] = v['u'].strip()
            raw = v['n'].strip()
            if raw != rec['name'] and raw not in rec['aliases']:
                rec['aliases'].append(raw)
            rec['styleAlt'] = v['s']
            rec['sceneAlt'] = v['c']
            used.add(id(v))
            continue

        # 多候选：优先选样音文件与已收录一致的那条，其余记为冲突
        pick = None
        if rec['sample']:
            base = rec['sample'].split('/')[-1]
            for v in cand:
                if (v['u'] or '').strip().split('/')[-1] == base:
                    pick = v
                    break
        if pick is None:
            pick = cand[0]

        if not rec['sample'] and pick['u'].strip():
            rec['sample'] = pick['u'].strip()
        rec['styleAlt'] = pick['s']
        rec['sceneAlt'] = pick['c']
        used.add(id(pick))

        for v in cand:
            if v is pick:
                continue
            same = (v['u'] or '').strip().split('/')[-1] == (rec['sample'] or '').split('/')[-1]
            add_conflict(
                v, key,
                '同名条目样音与已收录一致（疑为场景标注重复）' if same
                else '同名条目但样音不同，需人工判断是否为另一音色'
            )
            used.add(id(v))

    # 未被使用的试听台条目
    for v in preview:
        if id(v) in used:
            continue
        nm = norm_name(v['n'])
        add_conflict(
            v, name2key.get(nm),
            '同名条目已存在，样音/场景标注不同，需人工确认' if nm in name2key
            else '试听台独有，对照表无此名'
        )
        used.add(id(v))

    return conflicts, matched_by_file


def finalize(records, order):
    """补齐语种、可用性、拼音，按可用性排序。"""
    for key in order:
        rec = records[key]

        lang = lang_of(rec.get('styleAlt'), rec['style'], rec['name'])
        if not lang:
            has_cjk = re.search(r'[\u4e00-\u9fa5]', rec['name'])
            lang = 'zh' if has_cjk else ('en' if re.search(r'[A-Za-z]{3,}', rec['name']) else 'zh')
        rec['lang'] = lang
        rec['scene'] = clean_scene(rec['scene'])
        dialect = dialect_of(rec)
        if dialect:
            rec['dialect'] = dialect

        has_sample = bool(rec['sample'])
        has_code = rec['hasCode']
        if has_sample and has_code:
            rec['availability'] = 'both'
        elif has_sample:
            rec['availability'] = 'listen'
        elif has_code:
            rec['availability'] = 'use'
        else:
            rec['availability'] = 'locked'

        rec['py'], rec['pyi'] = pinyin_of(rec['name'])

    rank = {'both': 0, 'use': 1, 'listen': 2, 'locked': 3}
    out = sorted(records.values(),
                 key=lambda x: (rank[x['availability']], x['scene'] or 'zzz', x['name']))
    for rec in out:
        rec.pop('hasCode', None)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.expanduser('~/WorkBuddy/2026-11-02-21-00-55'))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
    args = ap.parse_args()

    preview, rows = load_sources(args.src)
    records, order, name2key = build_records(rows)
    conflicts, matched_by_file = merge_preview(records, order, name2key, preview)
    voices = finalize(records, order)

    counts = collections.Counter(v['availability'] for v in voices)
    data = {
        'meta': {
            'version': '1.0',
            'generatedAt': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
            'primaryKey': 'code',
            'total': len(voices),
            'counts': dict(counts),
            'langs': dict(collections.Counter(v['lang'] for v in voices)),
            'conflictsCount': len(conflicts),
            'conflictsResolved': sum(1 for c in conflicts if c.get('resolved')),
            'sources': [
                'www.xfyun.cn/services/online_tts (121 条内联样音)',
                'www.xfyun.cn/herapi/product/tts_language_list (158 条官方目录)',
                'saas.xfyun.cn/speech (68 条角色音色)',
            ],
            'fieldNotes': {
                'code': '主键；有官方编码用编码，否则 name:<归一化名称>',
                'availability': 'both=能听能用 / listen=仅能听 / use=仅能用 / locked=需控制台开通',
                'gender': 'male/female/child/unknown',
                'lang': 'ISO 语言码，zh 默认；yue=粤语，sc=四川话',
                'py/pyi': '名称全拼 / 首字母，只由 name 生成',
                'styleAlt/sceneAlt': '试听台细分风格与场景，仅参考不覆盖对照表',
                'flags': 'no_code / missing_scene',
            },
            'notes': 'conflicts 为未合入 voices 的重复/未匹配条目，需人工确认',
        },
        'voices': voices,
        'conflicts': conflicts,
    }

    os.makedirs(args.out, exist_ok=True)
    p_compact = os.path.join(args.out, 'voices.json')
    p_pretty = os.path.join(args.out, 'voices.pretty.json')
    json.dump(data, open(p_compact, 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(data, open(p_pretty, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)

    print(f'写入 {p_compact}')
    print(f'  voices: {len(voices)}  {dict(counts)}')
    print(f'  conflicts: {len(conflicts)}   文件名反查补回: {matched_by_file}')


if __name__ == '__main__':
    main()
