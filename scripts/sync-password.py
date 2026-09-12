#!/usr/bin/env python3
"""opencode Basic 認証パスワードの一元配布スクリプト。

背景: GitHub の Codespaces シークレットは書き込み専用で読み返せないため、
表示値・実効値を完全に一元化することはできない。そこで運用として
「.env.local の OPENCODE_SERVER_PASSWORD を正本」とし、本スクリプトで
配布先へ同期する。

配布先:
  1. GitHub リポジトリの Codespaces シークレット（Codespace 実効値）
  2. --vercel 指定時: Vercel 本番環境変数（本番 Dashboard 表示値）

--restart 指定時: Codespace を再起動して新しい値を再注入する
（シークレット変更だけでは実行中の環境に反映されないため）。

秘密値は表示・記録しない。更新成否のみを出力する。

前提: PyNaCl（pip install pynacl）、Vercel 配布には vercel CLI とログイン。

使用例:
  python scripts/sync-password.py --vercel --restart
  python scripts/sync-password.py --codespace my-codespace-name --vercel
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    from nacl import public as nacl_public, encoding as nacl_encoding
except ImportError:
    print('ERROR: PyNaCl が必要です: pip install pynacl')
    sys.exit(1)

REPO = 'Densyakun/opencode-workspace'
SECRET_NAME = 'OPENCODE_SERVER_PASSWORD'


def load_dotenv(path):
    values = {}
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip().strip('\'"')
    return values


def gh_api(token, method, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, method=method, data=data,
        headers={'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28',
                 'Authorization': f'Bearer {token}',
                 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode() or '{}'
            return r.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode()[:200]}


def sync_repo_secret(token, password):
    """リポジトリ Codespaces シークレットを上書きする。"""
    status, key = gh_api(token, 'GET',
                         f'https://api.github.com/repos/{REPO}/codespaces/secrets/public-key')
    if status != 200:
        print(f'REPO_SECRET_PUBKEY_FAILED:{status}')
        return False
    pubkey = nacl_public.PublicKey(key['key'], encoder=nacl_encoding.Base64Encoder())
    encrypted = base64.b64encode(nacl_public.SealedBox(pubkey).encrypt(password.encode('utf-8'))).decode()
    status, _ = gh_api(token, 'PUT',
                       f'https://api.github.com/repos/{REPO}/codespaces/secrets/{SECRET_NAME}',
                       {'encrypted_value': encrypted, 'key_id': key['key_id']})
    if status not in (201, 204):
        print(f'REPO_SECRET_UPDATE_FAILED:{status}')
        return False
    print('REPO_SECRET_UPDATED')
    return True


def sync_vercel(password):
    """Vercel 本番環境変数を上書きする。CLI 必須。改行混入防止のため一時ファイル経由。"""
    if not shutil.which('vercel'):
        print('VERCEL_SKIPPED: vercel CLI が見つかりません')
        return False
    tmp = tempfile.mktemp(prefix='ocpw-')
    try:
        # 末尾改行なしで書き込む（認証ずれ防止）
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(password)
        rm = subprocess.run(['vercel', 'env', 'rm', SECRET_NAME, 'production', '--yes'],
                            capture_output=True, text=True, timeout=60)
        if rm.returncode != 0:
            print('VERCEL_RM_NOTE: 既存値なし、または削除できませんでした（続行）')
        with open(tmp, 'rb') as stdin_file:
            add = subprocess.run(['vercel', 'env', 'add', SECRET_NAME, 'production'],
                                 stdin=stdin_file, capture_output=True, text=True, timeout=60)
        if add.returncode != 0 or 'Added' not in (add.stdout + add.stderr):
            print('VERCEL_ADD_FAILED')
            return False
        print('VERCEL_UPDATED: 本番反映には再デプロイ（vercel --prod）が必要です')
        return True
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def restart_codespace(token, name):
    """Codespace を再起動してシークレットを再注入する。"""
    status, _ = gh_api(token, 'POST', f'https://api.github.com/user/codespaces/{name}/stop')
    if status not in (200, 201, 202):
        print(f'RESTART_STOP_FAILED:{status}')
        return False
    for _ in range(30):
        time.sleep(10)
        status, info = gh_api(token, 'GET', f'https://api.github.com/user/codespaces/{name}')
        if status == 200 and str(info.get('state', '')).lower() in ('stopped', 'shutdown'):
            break
    else:
        print('RESTART_STOP_TIMEOUT')
        return False
    status, _ = gh_api(token, 'POST', f'https://api.github.com/user/codespaces/{name}/start')
    if status not in (200, 201, 202):
        print(f'RESTART_START_FAILED:{status}')
        return False
    print('RESTARTED')
    return True


def main():
    parser = argparse.ArgumentParser(description='opencode パスワードを正本から配布する')
    parser.add_argument('--env-file', default='.env.local')
    parser.add_argument('--vercel', action='store_true', help='Vercel 本番環境変数にも配布')
    parser.add_argument('--restart', action='store_true', help='配布後に Codespace を再起動')
    parser.add_argument('--codespace', default=None, help='再起動対象（既定: 先頭の1台）')
    args = parser.parse_args()

    cfg = load_dotenv(args.env_file)
    token = cfg.get('GITHUB_CODESPACES_TOKEN', '')
    password = cfg.get('OPENCODE_SERVER_PASSWORD', '')
    if not token or not password:
        print('ERROR: .env.local に GITHUB_CODESPACES_TOKEN と OPENCODE_SERVER_PASSWORD が必要です')
        return 1

    if not sync_repo_secret(token, password):
        return 1
    if args.vercel and not sync_vercel(password):
        return 1
    if args.restart:
        name = args.codespace
        if not name:
            status, data = gh_api(token, 'GET', 'https://api.github.com/user/codespaces?per_page=100')
            if status != 200 or not data.get('codespaces'):
                print('RESTART_FAILED: 対象 Codespace が見つかりません')
                return 1
            name = data['codespaces'][0]['name']
        if not restart_codespace(token, name):
            return 1
    print('DONE')
    return 0


if __name__ == '__main__':
    sys.exit(main())
