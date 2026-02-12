# openclaw-misskey

OpenClaw plugin for Misskey. `what` CLI バイナリを使って Misskey インスタンスに接続する。

## インストール

```
openclaw plugins install -l ./openclaw-plugin
```

または、OpenClaw の extensions ディレクトリにコピー:

```
cp -r openclaw-plugin ~/.openclaw/extensions/misskey
```

## 前提条件

- `what` バイナリがビルド済みで PATH に通っていること
- `what` の config.toml が設定済みであること

## 設定

`~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "misskey": {
      "accounts": {
        "default": {
          "enabled": true
        }
      }
    }
  },
  "plugins": {
    "entries": {
      "misskey": {
        "enabled": true,
        "config": {
          "cliBinary": "/path/to/what",
          "mentionOnly": false
        }
      }
    }
  }
}
```

## 提供機能

### チャンネル

Misskey を OpenClaw のメッセージングチャンネルとして登録する。
テキスト送信 (`sendText`) と返信に対応。

### Agent Tools

| Tool | 説明 |
|---|---|
| `misskey_post` | ノート投稿 (CW, visibility, reply, quote 対応) |
| `misskey_timeline` | タイムライン取得 |
| `misskey_search` | ノート検索 |
| `misskey_react` | リアクション追加 |
| `misskey_notifications` | 通知一覧 |
| `misskey_note_show` | ノート詳細表示 |

### Auto-reply コマンド

| コマンド | 説明 |
|---|---|
| `/mkpost <text>` | ノート投稿 |
| `/mktl` | タイムライン表示 (5件) |

### バックグラウンドサービス

`misskey-stream` -- Streaming API に接続してリアルタイム監視。
