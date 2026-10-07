"""Read a configured Feishu project and queue one existing Codex session.

This process never executes project tasks, sends Feishu messages, removes a
worker lock, or changes the worker's state.json. Existing approval policies stay
on the target session. launchd supplies the recurring trigger.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import uuid


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')


def read_json(path, default=None):
    path = pathlib.Path(path)
    return json.loads(path.read_text()) if path.exists() else default


def save(path, value):
    path = pathlib.Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def lock_owner_metadata(worker_lock):
    """Owner metadata is diagnostic; an existing lock always blocks dispatch."""
    try:
        owner = read_json(worker_lock / 'owner.json', None)
        if not isinstance(owner, dict):
            return {'owner': {}, 'owner_read_status': 'unavailable',
                    'owner_read_error': 'owner metadata missing or not an object'}
        return {'owner': owner, 'owner_read_status': 'readable'}
    except (OSError, ValueError) as error:
        return {'owner': {}, 'owner_read_status': 'unavailable', 'owner_read_error': str(error)}


def revisions(messages):
    fields = ('content', 'mentions', 'deleted', 'sender', 'msg_type', 'update_time')
    return {m['message_id']: hashlib.sha256(json.dumps(
        {k: m.get(k) for k in fields}, sort_keys=True, ensure_ascii=False
    ).encode()).hexdigest() for m in messages}


def validate_history(response):
    data = response.get('data', {})
    complete = response.get('meta', {}).get('pagination', {}).get('complete', not data.get('has_more', True))
    if not response.get('ok') or response.get('identity') != 'user' or data.get('has_more', True) or not complete:
        raise ValueError('project history read failed, identity differs, or pagination incomplete')
    return data['messages']


def dispatch_reason(changed, unfinished, busy, pending):
    if busy or pending:
        return None
    if changed:
        return 'changed_messages'
    if unfinished:
        return 'unfinished_work'
    return None


def retain_changes(dirty, current, previous):
    dirty = dict(dirty)
    for key in set(current) | set(previous):
        if current.get(key) != previous.get(key):
            dirty[key] = current.get(key)
    return dirty


def pending_terminal_state(pending, stream):
    accepted = False
    active_turn = None
    accepted_turn = None
    for record in stream:
        if record.get('timestamp', '') < pending['queued_at']:
            continue
        payload = record.get('payload', {})
        kind = payload.get('type')
        turn = payload.get('turn_id')
        if record.get('type') == 'event_msg' and kind == 'task_started':
            if accepted and accepted_turn and turn != accepted_turn:
                return 'aborted'
            if accepted and not accepted_turn:
                accepted_turn = turn
            active_turn = turn
        if kind == 'message' and payload.get('role') == 'user':
            content = ' '.join(c.get('text', '') for c in payload.get('content', []) if isinstance(c, dict))
            if pending['marker'] in content:
                accepted = True
                accepted_turn = turn or active_turn
        if not accepted:
            continue
        matching = not accepted_turn or not turn or turn == accepted_turn
        if record.get('type') == 'event_msg' and matching:
            if kind == 'turn_aborted':
                return 'aborted'
            if kind == 'task_complete':
                return 'complete'
    return None


def pending_finished(pending, stream):
    return pending_terminal_state(pending, stream) == 'complete'


def records(path):
    with pathlib.Path(path).open() as stream:
        for line in stream:
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue  # Ignore an actively appended partial final record.


def session_busy(path):
    busy = False
    for record in records(path):
        payload = record.get('payload', {})
        if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
            busy = True
        if record.get('type') == 'event_msg' and payload.get('type') in ('task_complete', 'turn_aborted'):
            busy = False
    return busy


def command(args, workspace, timeout=120):
    env = dict(os.environ, LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1')
    result = subprocess.run(args, cwd=workspace, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Do not copy arbitrary output or authentication material into diagnostics.
        raise RuntimeError('command failed: ' + pathlib.Path(args[0]).name + ' exit ' + str(result.returncode))
    return result.stdout


def notify_error(status, settings, config, status_path, incident, error):
    if status.get('last_alert_incident') == incident and status.get('alert_delivery') in ('queued', 'observed'):
        return
    marker = 'shenlai-alert-' + incident[:12]
    # Recover a receipt lost after delivery before retrying the same notification.
    try:
        if any(marker in json.dumps(r, ensure_ascii=False) for r in records(settings['session_log'])):
            status.update(last_alert_incident=incident, alert_delivery='observed')
            return
    except OSError:
        pass
    alert = ('[自动检查受阻 ' + marker + '] 神来项目定时检查失败：' + error +
             '。请只在当前执行窗口告知本人具体阻塞及恢复条件；同一标识已告知则不重复通知。'
             '不要发群消息，不执行未完整读取的新任务。调度记录：' + str(status_path))
    status.update(last_alert_incident=incident, last_alert_attempt_at=now())
    try:
        status['alert_receipt'] = command([settings['codex'], 'queue', '--thread', settings['thread_id'], '--message', alert],
                                          config['workspace'], timeout=60).strip()
        status['alert_delivery'] = 'queued'
    except Exception:
        status['alert_delivery'] = 'unavailable; inspect local scheduler status when the session is restored'


def tick(settings, origin):
    project = pathlib.Path(settings['project_config'])
    private = project.parent
    status_path = private / 'scheduler-status.json'
    with (private / 'poller.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'outcome': 'poller_already_running'}
        status = read_json(status_path, {})
        status.update(last_trigger_at=now(), trigger_origin=origin, interval_seconds=600,
                      window_mode='all_day', target_thread_id=settings['thread_id'], read_complete=False)
        config = read_json(project)
        if not config['schedule'].get('enabled'):
            status.update(outcome='disabled', enabled=False)
            notice = status.get('needs_input', {})
            if notice.get('kind') == 'automatic_turn_aborted' and status.get('alert_delivery', '').startswith('unavailable'):
                notify_error(status, settings, config, status_path, notice['incident_id'], notice['question'])
            save(status_path, status)
            return status
        save(status_path, status)
        try:
            workspace = settings.get('project_workspace', config['workspace'])
            expected_workspace = config.get('project_workspace')
            if expected_workspace and os.path.abspath(workspace) != os.path.abspath(expected_workspace):
                raise ValueError('project workspace binding mismatch')
            if config.get('branch_id') and config['branch_id'] != settings.get('branch_id'):
                raise ValueError('project branch binding mismatch')
            status.update(target_project_workspace=workspace, target_branch_id=settings.get('branch_id'),
                          target_worker_state=settings.get('worker_state', str(private / 'state.json')))
            auth = json.loads(command([settings['lark'], 'auth', 'status', '--json', '--verify'], config['workspace']))
            user = auth.get('identities', {}).get('user', {})
            if not user.get('verified') or user.get('openId') != config['owner_open_id']:
                raise ValueError('owner identity is not verified')
            output = command([settings['lark'], 'im', '+chat-messages-list', '--chat-id', config['chat_id'],
                              '--page-all', '--no-reactions', '--as', 'user', '--format', 'json'], config['workspace'])
            response = json.loads(output)
            messages = validate_history(response)
            current = revisions(messages)
            previous = status.get('message_revisions', {})
            changed_ids = [key for key, value in current.items() if previous.get(key) != value]
            removed_ids = [key for key in previous if key not in current]
            dirty = retain_changes(status.get('unhandled_changes', {}), current, previous)
            status['unhandled_changes'] = dirty
            status.update(last_check_at=now(), read_complete=True, message_count=len(messages),
                          message_revisions=current, changed_message_ids=changed_ids, removed_message_ids=removed_ids,
                          last_error=None, enabled=True)
            save(private / 'scheduler-history-latest.json', response)
            pending = status.get('pending_dispatch')
            terminal = pending_terminal_state(pending, records(settings['session_log'])) if pending else None
            if terminal == 'aborted':
                pending['status'] = 'aborted'
                status['last_interrupted_dispatch'] = dict(pending, observed_interrupted_at=now())
                status['pending_dispatch'] = None
                config['schedule'].update(enabled=False, pause_reason='automatic turn interrupted', paused_at=now())
                save(project, config)
                status.update(outcome='suspended', enabled=False, needs_input={
                    'kind': 'automatic_turn_aborted', 'marker': pending['marker'],
                    'question': '自动轮次被中断，已暂停派发；需要本人明确恢复后再处理保留的待办。'})
                incident = hashlib.sha256(('aborted:' + pending['marker']).encode()).hexdigest()
                status['needs_input']['incident_id'] = incident
                notify_error(status, settings, config, status_path, incident, status['needs_input']['question'])
                save(status_path, status)
                return status
            state = read_json(settings.get('worker_state', str(private / 'state.json')), {})
            worker_lock = pathlib.Path(settings.get('project_workspace', config['workspace'])) / '.feishu-project-runner' / 'run.lock'
            lock_present = worker_lock.exists()
            result = state.get('round_result', {})
            result_matches = bool(pending and result.get('marker') == pending['marker'])
            waiting = result_matches and result.get('outcome') == 'waiting_for_lock'
            processed = result_matches and result.get('outcome') == 'processed' and result.get('read_complete') is True
            if terminal == 'complete':
                if processed:
                    for key, value in pending.get('input_changes', {}).items():
                        if dirty.get(key) == value:
                            dirty.pop(key, None)
                    status['last_completed_dispatch'] = dict(pending, observed_complete_at=now(), round_result=result)
                elif waiting:
                    status['last_waiting_dispatch'] = dict(pending, observed_waiting_at=now())
                else:
                    # A finished conversation is not evidence that project inputs were processed.
                    status.update(outcome='awaiting_round_result', needs_input={
                        'kind': 'round_result_missing', 'marker': pending['marker'],
                        'question': '自动轮次已结束但缺少匹配marker的处理结果；保留待办，需核对该轮是否实际完整读取和处理。'})
                    incident = hashlib.sha256(('round-result:' + pending['marker']).encode()).hexdigest()
                    status['needs_input']['incident_id'] = incident
                    notify_error(status, settings, config, status_path, incident, status['needs_input']['question'])
                    save(status_path, status)
                    return status
                status['pending_dispatch'] = pending = None
                if status.get('needs_input', {}).get('kind') in ('queue_delivery_unknown', 'round_result_missing'):
                    status['last_resolved_incident'] = dict(status.pop('needs_input'), recovered_at=now())
            busy = session_busy(settings['session_log'])
            if status.get('needs_input', {}).get('kind') in ('poller_error', 'automatic_turn_aborted'):
                status['last_resolved_incident'] = dict(status.pop('needs_input'), recovered_at=now())
                status.pop('last_alert_incident', None)
            status['installation_status'] = 'verified_live_trigger' if origin == 'launchd' else status.get('installation_status')
            if lock_present:
                status.update(outcome='waiting_for_lock', waiting_for_lock={
                    'path': str(worker_lock), **lock_owner_metadata(worker_lock),
                    'observed_at': now(), 'next_action': 'recheck at next tick; never remove another owner lock'})
                save(status_path, status)
                return status
            status.pop('waiting_for_lock', None)
            unfinished = not state or any(t.get('status') in ('queued', 'in_progress', 'blocked', 'waiting_for_lock') for t in state.get('tasks', []))
            reason = dispatch_reason(bool(dirty), unfinished, busy, bool(pending))
            if reason:
                marker = 'shenlai-auto-' + str(uuid.uuid4())
                prompt = ('[自动检查轮次 ' + marker + '] 用户已授权全天24小时、每10分钟推进神来项目，其余授权与规则不变。'
                          '重新读取本机已安装的 $feishu-project-runner，使用本项目配置和台账。'
                          '延续用户已明确授予的持续推进范围；“看看新消息/检查一下”不自动撤销既有执行授权，'
                          '除非用户明确要求只读、暂停或本轮不得执行。读完交付后继续依赖核对、本人复查及已有授权内的修正。'
                          '先取得独占锁、核验本人并完整回读神来群和关键附件，判断项目相关性、本人分工及授权。'
                          '发现同事新交付满足依赖时恢复待办，持续完成可执行工作并实际检查，不等待逐项“继续”；'
                          '待确认项集中提出建议和影响，已问未变的不重复问，继续独立工作。'
                          '外部依赖blocked项每轮只核查通道或依赖是否恢复，恢复后继续；仍受阻不重复通知、不把真人待答当作已批准。'
                          '只有本人实质成果检查后按用户最新渠道要求报告；飞书使用配置的机器人，@配置的本人并按分工添加需行动成员。'
                          '不发配置/巡检消息，不冒领、不重复报告，不替代真人签收或双方归一，保留所有审批门禁。'
                          '本机 scheduler-status.json 是调度触发及读群证据；不要自行另建调度器或覆盖此文件。'
                          '锁已占用时记录waiting_for_lock，不要求本人重复批准继续；只释放自己的锁。结束前更新任务、检查与读取台账。')
                prompt += ('项目工作目录为 ' + settings.get('project_workspace', config['workspace']) +
                           '；先读取该目录下 .feishu-project-runner/config.json 与 state.json，核对workspace及分工，'
                           '不得回退到父目录另一分支的台账或锁。配置绝对路径为 ' +
                           str(pathlib.Path(workspace) / '.feishu-project-runner/config.json') +
                           '；调度记录位于 ' + str(status_path) + '，不要覆盖此文件。'
                           '收尾后将任务状态摘要（task_id/status/next_action）写入 ' +
                           settings.get('worker_state', str(private / 'worker-state.json')) +
                           ' 供轮询器判断未完成工作，保持原项目完整台账。摘要必须包含round_result：marker为本轮完整标识，'
                           'outcome仅在完整读群并处理可执行项/明确阻塞后填processed且read_complete=true；'
                           '无法取锁填waiting_for_lock且read_complete=false，其他失败填incomplete。'
                           '仅写worker摘要，不覆盖scheduler-status.json或他人完整台账。'
                           '收尾前逐项核对仍可执行的next_action；只要尚有已授权可执行项就在本轮继续。'
                           '只有具体外部依赖、真人决定、权限/读取失败、暂停或运行限制才收尾，并记明恢复条件。')
                if settings.get('branch_id'):
                    preflight = ['python3', 'scripts/check_binding.py', '--workspace', workspace,
                                 '--branch-id', settings['branch_id'], '--owner-open-id', config['owner_open_id'],
                                 '--chat-id', config['chat_id'], '--automatic']
                    prompt += ('执行项目动作前，在已安装skill目录运行只读校验，argv为 ' +
                               json.dumps(preflight, ensure_ascii=False) +
                               '；它必须读取实际分支配置并verified=true。后台只核对服务镜像绑定，不能代替此实际校验。'
                               '失败时写round_result outcome=incomplete并说明具体阻塞，不能回退目录或擅自恢复暂停。')
                pending = {'marker': marker, 'queued_at': now(), 'reason': reason, 'status': 'sending', 'input_changes': dict(dirty)}
                status['pending_dispatch'] = pending
                save(status_path, status)  # Unknown delivery must not be blindly retried.
                receipt = command([settings['codex'], 'queue', '--thread', settings['thread_id'], '--message', prompt],
                                  config['workspace'], timeout=60)
                pending.update(status='queued', receipt=receipt.strip())
                status.update(outcome='queued', last_dispatch_at=now())
            else:
                status['outcome'] = 'worker_busy' if busy else 'dispatch_pending' if pending else 'idle'
            unresolved = status.get('needs_input', {})
            if unresolved.get('kind') == 'queue_delivery_unknown' and status.get('alert_delivery', '').startswith('unavailable'):
                notify_error(status, settings, config, status_path, unresolved['incident_id'], status.get('last_error') or unresolved['question'])
            save(status_path, status)
        except Exception as error:
            status.update(outcome='error', last_error=str(error), last_error_at=now())
            pending = status.get('pending_dispatch')
            if pending and pending.get('status') == 'sending':
                pending['status'] = 'delivery_unknown'
                status['needs_input'] = {'kind': 'queue_delivery_unknown',
                                        'question': '核对目标会话是否收到该marker；确认未送达或明确取消该轮次后才清除pending_dispatch并重试。',
                                        'marker': pending['marker'], 'notified_in_status_at': now()}
            else:
                status['needs_input'] = {'kind': 'poller_error', 'question': str(error)}
            incident = hashlib.sha256((status['needs_input']['kind'] + str(error)).encode()).hexdigest()
            status['needs_input']['incident_id'] = incident
            notify_error(status, settings, config, status_path, incident, str(error))
            save(status_path, status)
        return status


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--settings', required=True)
    parser.add_argument('--origin', default='manual')
    args = parser.parse_args()
    result = tick(read_json(args.settings), args.origin)
    print(json.dumps({key: result.get(key) for key in ('last_trigger_at', 'last_check_at', 'outcome', 'message_count', 'last_error')}, ensure_ascii=False))
    sys.exit(1 if result.get('outcome') == 'error' else 0)
