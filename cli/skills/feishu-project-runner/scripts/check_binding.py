"""Read-only preflight inside the execution window, before automatic work."""
import argparse
import json
import pathlib
import sys


def check_binding(workspace, branch_id, owner_open_id, chat_id, automatic=False):
    expected = pathlib.Path(workspace).resolve(strict=True)
    config = json.loads((expected / '.feishu-project-runner/config.json').read_text())
    if pathlib.Path(config['workspace']).resolve(strict=True) != expected:
        raise ValueError('actual workspace binding mismatch')
    for key, value in [('branch_id', branch_id), ('owner_open_id', owner_open_id), ('chat_id', chat_id)]:
        if not value or config.get(key) != value:
            raise ValueError('actual ' + key + ' binding mismatch')
    if automatic and config.get('schedule', {}).get('enabled') is not True:
        raise ValueError('actual branch automatic schedule is disabled')
    return {'verified': True, 'workspace': str(expected), 'branch_id': branch_id,
            'owner_open_id': owner_open_id, 'chat_id': chat_id}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['workspace', 'branch-id', 'owner-open-id', 'chat-id']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--automatic', action='store_true')
    args = parser.parse_args()
    try:
        result = check_binding(args.workspace, args.branch_id, args.owner_open_id, args.chat_id, args.automatic)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'verified': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))
