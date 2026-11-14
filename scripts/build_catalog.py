#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_catalog.py — 生成插件运行时读的两份数据（开发时运行，插件运行时不需要 Python）

    data/catalog.json      音色目录：voices.json + 超拟人编码 + 官方音色名
    data/polyphones.json   常见多音字，voice_speak 只把这些字的读音标给模型看

用法：
    pip3 install --user pypinyin
    python3 scripts/build_catalog.py

输入：
    data/voices.json             build_data.py 的产物
    data/hyper-vcn-enum.json     超拟人接口报错里带的合法编码（M0 实测，见 spike/M0-验证报告.md）
    data/hyper-voice-names.json  讯飞官方 iFly-Skills 的音色表（Apache-2.0）
"""

import json
import os
import re
import sys
from collections import defaultdict

try:
    from pypinyin import lazy_pinyin, Style
    from pypinyin.phrases_dict import phrases_dict
except ImportError:
    sys.exit('缺少依赖: pip3 install --user pypinyin')

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATA = os.path.join(ROOT, 'data')

# 一、不的连读变调和轻声太常见，标出来只会增加噪音，模型也不需要判断
NOISY_POLYPHONES = set('一不的了')

# 官方表把 Grant 标成女声，这是男性名字，没有听证实前按未知处理，不把可疑标注交给模型
GENDER_UNSURE = {'x5_EnUs_Grant_flow'}


def load(name):
    with open(os.path.join(DATA, name), encoding='utf-8') as f:
        return json.load(f)


def dump(name, value):
    with open(os.path.join(DATA, name), 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, separators=(',', ':'))


def pinyin_of(name):
    clean = re.sub(r'[^一-龥A-Za-z0-9]', '', name or '')
    return ''.join(lazy_pinyin(clean)).lower(), ''.join(lazy_pinyin(clean, style=Style.FIRST_LETTER)).lower()


def gender_of(text):
    text = text or ''
    if '童' in text:
        return 'child'
    if '女' in text:
        return 'female'
    if '男' in text:
        return 'male'
    return 'unknown'


def lang_of_hyper(vcn, lang_text):
    if 'EnUs' in vcn or '英' in (lang_text or ''):
        return 'en'
    return 'zh'


def build_catalog():
    voices = load('voices.json')['voices']
    enum = set(load('hyper-vcn-enum.json'))
    named = {v['vcn']: v for v in load('hyper-voice-names.json')}

    by_name = defaultdict(list)
    catalog = {}

    for v in voices:
        code = v['code']
        has_code = not code.startswith('name:')
        catalog[code] = {
            'code': code,
            'name': v['name'],
            'aliases': v.get('aliases') or [],
            'engine': ('hyper' if code in enum else 'v2') if has_code else None,
            'gender': v.get('gender', 'unknown'),
            'lang': v.get('lang', 'zh'),
            'dialect': v.get('dialect'),
            'scene': v.get('scene'),
            'style': v.get('styleAlt') or v.get('style') or None,
            'sample': v.get('sample'),
            'py': v.get('py', ''),
            'pyi': v.get('pyi', ''),
        }
        by_name[v['name']].append(code)

    for vcn in sorted(enum):
        info = named.get(vcn) or {}
        name = info.get('name')
        lang_text = info.get('lang')
        record = {
            'code': vcn,
            'name': name or vcn,
            'aliases': [],
            'engine': 'hyper',
            'gender': gender_of(info.get('gender')) if info and vcn not in GENDER_UNSURE else 'unknown',
            'lang': lang_of_hyper(vcn, lang_text),
            'dialect': '台湾' if lang_text == '台湾腔' else None,
            'scene': info.get('scene'),
            'style': None,
            'sample': None,
            'py': pinyin_of(name)[0] if name else vcn.lower(),
            'pyi': pinyin_of(name)[1] if name else '',
        }
        if vcn in catalog:
            # 官方目录已有这个编码：只补引擎，保留样音和风格
            catalog[vcn]['engine'] = 'hyper'
            continue
        catalog[vcn] = record
        # saas 角色音色在旧数据里只有名字、没有编码（name:xxx），现在能对上了就合并
        if name:
            for code in by_name.get(name, []):
                if code.startswith('name:') and code in catalog:
                    old = catalog.pop(code)
                    record['sample'] = old['sample']
                    record['gender'] = record['gender'] if record['gender'] != 'unknown' else old['gender']
                    record['scene'] = record['scene'] or old['scene']

    rows = sorted(catalog.values(), key=lambda r: (r['engine'] is None, r['engine'] != 'hyper', r['code']))
    return rows


def build_polyphones():
    """词库里至少两种读音、且每种都出现过不止一次的字，才算真正常见的多音字。"""
    seen = defaultdict(lambda: defaultdict(int))
    for phrase, readings in phrases_dict.items():
        if len(phrase) != len(readings):
            continue
        for char, reading in zip(phrase, readings):
            seen[char][reading[0]] += 1
    chars = [c for c, r in seen.items()
             if sum(1 for n in r.values() if n >= 2) >= 2 and c not in NOISY_POLYPHONES]
    return ''.join(sorted(chars))


def main():
    rows = build_catalog()
    dump('catalog.json', rows)
    polyphones = build_polyphones()
    dump('polyphones.json', polyphones)
    hyper = sum(1 for r in rows if r['engine'] == 'hyper')
    v2 = sum(1 for r in rows if r['engine'] == 'v2')
    none = sum(1 for r in rows if r['engine'] is None)
    named = sum(1 for r in rows if r['engine'] == 'hyper' and r['name'] != r['code'])
    print(f'catalog.json: {len(rows)} 条（超拟人 {hyper}，其中有名字 {named}；v2 {v2}；无编码 {none}）')
    print(f'polyphones.json: {len(polyphones)} 字')


if __name__ == '__main__':
    main()
