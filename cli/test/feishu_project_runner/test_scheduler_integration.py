"""Exercise the real poller and filesystem across simulated external CLIs."""
import importlib.util
import fcntl
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'skills' / 'feishu-project-runner'


class PollerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = pathlib.Path(self.tmp.name)
        spec = importlib.util.spec_from_file_location('poller', ROOT / 'scripts/scheduler.py')
        self.poller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.poller)
        script = '''#!/usr/bin/python3
import json, pathlib, sys
b = pathlib.Path(__file__).parent
if pathlib.Path(sys.argv[0]).name == 'codex':
    with (b / 'queue-calls.jsonl').open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')
    if (b / 'queue-fail').exists(): sys.exit(1)
    print('Queued message test-receipt for thread test-thread.')
else:
    if sys.argv[1] == 'auth': print((b / 'auth.json').read_text())
    else: print((b / 'history.json').read_text())
'''
        for name in ['lark', 'codex']:
            p = self.base / name
            p.write_text(script)
            p.chmod(0o700)
        self.write('config.json', {'owner_open_id': 'owner', 'chat_id': 'chat', 'workspace': str(self.base), 'schedule': {'enabled': True}})
        self.write('auth.json', {'identities': {'user': {'verified': True, 'openId': 'owner'}}})
        self.write('history.json', {'ok': True, 'identity': 'user', 'data': {'has_more': False, 'messages': [{'message_id': 'delivery', 'content': 'v2'}]}})
        self.write('worker.json', {'tasks': [{'task_id': 'task', 'status': 'awaiting_human'}]})
        (self.base / 'session.jsonl').write_text('')
        self.settings = {'project_config': str(self.base / 'config.json'), 'thread_id': 'test-thread',
                         'session_log': str(self.base / 'session.jsonl'), 'worker_state': str(self.base / 'worker.json'),
                         'lark': str(self.base / 'lark'), 'codex': str(self.base / 'codex')}

    def write(self, name, value):
        (self.base / name).write_text(json.dumps(value))

    def queue_count(self):
        p = self.base / 'queue-calls.jsonl'
        return len(p.read_text().splitlines()) if p.exists() else 0

    def finish(self, pending, acknowledge=True):
        if acknowledge:
            state = json.loads((self.base / 'worker.json').read_text())
            state['round_result'] = {'marker': pending['marker'], 'outcome': 'processed', 'read_complete': True}
            self.write('worker.json', state)
        records = [{'timestamp': self.poller.now(), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': pending['marker']}]}},
                   {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'task_complete'}}]
        with (self.base / 'session.jsonl').open('a') as f:
            for r in records: f.write(json.dumps(r) + '\n')

    def hold_worker_lock(self):
        path = self.base / '.feishu-project-runner' / 'run.lock'
        path.mkdir(parents=True)
        (path / 'owner.json').write_text(json.dumps({'run_id': 'another-run', 'thread_id': 'another-thread'}))
        return path

    def test_worker_lock_preserves_delivery_then_resumes(self):
        lock = self.hold_worker_lock()
        for _ in range(3):
            result = self.poller.tick(self.settings, 'test')
            self.assertEqual(result['outcome'], 'waiting_for_lock')
            self.assertIn('delivery', result['unhandled_changes'])
        self.assertEqual(self.queue_count(), 0)
        (lock / 'owner.json').unlink()
        lock.rmdir()
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'queued')
        self.assertEqual(self.queue_count(), 1)

    def test_completed_turn_without_result_does_not_consume_delivery(self):
        first = self.poller.tick(self.settings, 'test')
        self.finish(first['pending_dispatch'], acknowledge=False)
        self.hold_worker_lock()
        result = self.poller.tick(self.settings, 'test')
        self.assertIn('delivery', result['unhandled_changes'])
        self.assertEqual(result['outcome'], 'awaiting_round_result')

    def test_lock_race_wait_ack_then_release_resumes(self):
        first = self.poller.tick(self.settings, 'test')
        lock = self.hold_worker_lock()
        self.finish(first['pending_dispatch'])
        self.write('worker.json', {'round_result': {'marker': first['pending_dispatch']['marker'], 'outcome': 'waiting_for_lock'}, 'tasks': []})
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'waiting_for_lock')
        self.assertIn('delivery', result['unhandled_changes'])
        (lock / 'owner.json').unlink()
        lock.rmdir()
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'queued')

    def test_stale_acknowledgement_is_not_completion(self):
        first = self.poller.tick(self.settings, 'test')
        self.finish(first['pending_dispatch'], acknowledge=False)
        self.write('worker.json', {'round_result': {'marker': 'older-round', 'outcome': 'processed', 'read_complete': True}, 'tasks': []})
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'awaiting_round_result')
        self.assertIn('delivery', result['unhandled_changes'])
        before = self.queue_count()
        self.poller.tick(self.settings, 'test')
        self.assertEqual(self.queue_count(), before)

    def test_lock_wait_keeps_latest_edit_and_respects_pause(self):
        lock = self.hold_worker_lock()
        self.poller.tick(self.settings, 'test')
        self.write('history.json', {'ok': True, 'identity': 'user', 'data': {'has_more': False, 'messages': [{'message_id': 'delivery', 'content': 'withdraw v2'}]}})
        result = self.poller.tick(self.settings, 'test')
        expected = self.poller.revisions([{'message_id': 'delivery', 'content': 'withdraw v2'}])
        self.assertEqual(result['unhandled_changes'], expected)
        config = json.loads((self.base / 'config.json').read_text())
        config['schedule']['enabled'] = False
        self.write('config.json', config)
        (lock / 'owner.json').unlink()
        lock.rmdir()
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'disabled')
        self.assertEqual(self.queue_count(), 0)

    def test_identity_recovery_while_waiting_for_lock_clears_old_alert(self):
        self.hold_worker_lock()
        self.write('auth.json', {'identities': {'user': {'verified': False, 'openId': 'owner'}}})
        self.poller.tick(self.settings, 'test')
        self.write('auth.json', {'identities': {'user': {'verified': True, 'openId': 'owner'}}})
        result = self.poller.tick(self.settings, 'launchd')
        self.assertEqual(result['outcome'], 'waiting_for_lock')
        self.assertNotIn('needs_input', result)
        self.assertEqual(result['installation_status'], 'verified_live_trigger')

    def test_one_delivery_one_queue_then_idle(self):
        first = self.poller.tick(self.settings, 'test')
        self.assertEqual(first['outcome'], 'queued')
        self.poller.tick(self.settings, 'test')
        self.assertEqual(self.queue_count(), 1)
        self.finish(first['pending_dispatch'])
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'idle')
        self.assertEqual(self.queue_count(), 1)

    def test_old_message_edit_dispatches_new_round(self):
        first = self.poller.tick(self.settings, 'test')
        self.finish(first['pending_dispatch'])
        self.poller.tick(self.settings, 'test')
        history = json.loads((self.base / 'history.json').read_text())
        history['data']['messages'][0]['content'] = 'cancel the old approval'
        self.write('history.json', history)
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'queued')
        self.assertEqual(self.queue_count(), 2)

    def test_existing_poller_lock_prevents_second_process(self):
        with (self.base / 'poller.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'poller_already_running')
            self.assertEqual(self.queue_count(), 0)

    def test_auth_failure_notifies_once_then_marks_recovery(self):
        self.write('auth.json', {'identities': {'user': {'verified': False, 'openId': 'owner'}}})
        first = self.poller.tick(self.settings, 'test')
        self.assertEqual(first['needs_input']['kind'], 'poller_error')
        self.poller.tick(self.settings, 'test')
        self.assertEqual(self.queue_count(), 1)  # One local alert; no project dispatch.
        self.write('auth.json', {'identities': {'user': {'verified': True, 'openId': 'owner'}}})
        recovered = self.poller.tick(self.settings, 'test')
        self.assertNotIn('needs_input', recovered)
        self.assertIn('last_resolved_incident', recovered)

    def test_busy_delivery_is_queued_after_worker_finishes(self):
        event = {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'task_started'}}
        (self.base / 'session.jsonl').write_text(json.dumps(event) + '\n')
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'worker_busy')
        self.assertEqual(self.queue_count(), 0)
        with (self.base / 'session.jsonl').open('a') as f:
            f.write(json.dumps({'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'task_complete'}}) + '\n')
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'queued')
        self.assertEqual(self.queue_count(), 1)

    def test_read_failure_does_not_claim_previous_read_success(self):
        self.poller.tick(self.settings, 'test')
        self.write('auth.json', {'identities': {'user': {'verified': False, 'openId': 'owner'}}})
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'error')
        self.assertFalse(result['read_complete'])

    def test_disable_does_not_keep_enabled_status(self):
        self.poller.tick(self.settings, 'test')
        config = json.loads((self.base / 'config.json').read_text())
        config['schedule']['enabled'] = False
        self.write('config.json', config)
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'disabled')
        self.assertFalse(result['enabled'])
        self.assertEqual(self.queue_count(), 1)

    def test_blocked_external_dependency_is_rechecked(self):
        first = self.poller.tick(self.settings, 'test')
        self.finish(first['pending_dispatch'])
        state = json.loads((self.base / 'worker.json').read_text())
        state['tasks'] = [{'task_id': 'task', 'status': 'blocked'}]
        self.write('worker.json', state)
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'queued')

    def test_failed_queue_reports_unknown_delivery_and_no_blind_retry(self):
        (self.base / 'queue-fail').touch()
        first = self.poller.tick(self.settings, 'test')
        self.assertEqual(first['outcome'], 'error')
        self.assertEqual(first['pending_dispatch']['status'], 'delivery_unknown')
        self.assertTrue(first['needs_input'])
        self.poller.tick(self.settings, 'test')
        calls = [json.loads(x) for x in (self.base / 'queue-calls.jsonl').read_text().splitlines()]
        self.assertEqual(sum('[自动检查轮次' in c[-1] for c in calls), 1)
        self.assertTrue(any('[自动检查受阻' in c[-1] for c in calls))

    def test_same_missing_session_error_alert_is_deduplicated(self):
        (self.base / 'session.jsonl').unlink()
        for _ in range(3):
            self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'error')
        self.assertEqual(self.queue_count(), 1)

    def test_aborted_round_suspends_without_fake_completion(self):
        first = self.poller.tick(self.settings, 'test')
        accepted = {'timestamp': self.poller.now(), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': first['pending_dispatch']['marker']}]}}
        aborted = {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'turn_aborted'}}
        later = [{'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'task_started'}},
                 {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'task_complete'}}]
        (self.base / 'session.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in [accepted, aborted]+later))
        result = self.poller.tick(self.settings, 'test')
        self.assertEqual(result['outcome'], 'suspended')
        self.assertNotIn('last_completed_dispatch', result)
        self.assertEqual(result['last_interrupted_dispatch']['status'], 'aborted')
        self.assertIsNone(result['pending_dispatch'])
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'disabled')

    def test_explicit_reenable_after_aborted_round_dispatches_preserved_work(self):
        first = self.poller.tick(self.settings, 'test')
        accepted = {'timestamp': self.poller.now(), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': first['pending_dispatch']['marker']}]}}
        aborted = {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'turn_aborted'}}
        (self.base / 'session.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in [accepted, aborted]))
        self.poller.tick(self.settings, 'test')
        config = json.loads((self.base / 'config.json').read_text())
        config['schedule']['enabled'] = True  # Explicit owner-approved recovery.
        self.write('config.json', config)
        recovered = self.poller.tick(self.settings, 'test')
        self.assertEqual(recovered['outcome'], 'queued')
        self.assertNotIn('needs_input', recovered)

    def test_queue_error_notification_is_delivered_after_channel_recovers(self):
        failure = self.base / 'queue-fail'
        failure.touch()
        self.poller.tick(self.settings, 'test')
        failure.unlink()
        recovered = self.poller.tick(self.settings, 'test')
        self.assertEqual(recovered['alert_delivery'], 'queued')
        self.assertEqual(recovered['pending_dispatch']['status'], 'delivery_unknown')
        calls = [json.loads(x) for x in (self.base / 'queue-calls.jsonl').read_text().splitlines()]
        self.assertEqual(sum('[自动检查轮次' in c[-1] for c in calls), 1)
        self.poller.tick(self.settings, 'test')
        self.assertEqual(self.queue_count(), len(calls))

    def test_paused_business_stays_paused_when_abort_notice_recovers(self):
        first = self.poller.tick(self.settings, 'test')
        accepted = {'timestamp': self.poller.now(), 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': first['pending_dispatch']['marker']}]}}
        aborted = {'timestamp': self.poller.now(), 'type': 'event_msg', 'payload': {'type': 'turn_aborted'}}
        (self.base / 'session.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in [accepted, aborted]))
        failure = self.base / 'queue-fail'
        failure.touch()
        self.assertEqual(self.poller.tick(self.settings, 'test')['outcome'], 'suspended')
        failure.unlink()
        recovered = self.poller.tick(self.settings, 'test')
        self.assertEqual(recovered['outcome'], 'disabled')
        self.assertFalse(recovered['enabled'])
        self.assertEqual(recovered['alert_delivery'], 'queued')
        count = self.queue_count()
        self.poller.tick(self.settings, 'test')
        self.assertEqual(self.queue_count(), count)


if __name__ == "__main__":
    unittest.main()
