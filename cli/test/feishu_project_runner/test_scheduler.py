import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'skills' / 'feishu-project-runner'


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        path = ROOT / 'scripts' / 'scheduler.py'
        self.assertTrue(path.exists(), 'actual polling runtime has not been implemented')
        spec = importlib.util.spec_from_file_location('scheduler', path)
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)

    def test_edited_old_message_is_detected(self):
        old = [{'message_id': 'old', 'content': 'approved', 'create_time': 'yesterday'}]
        new = [{'message_id': 'old', 'content': 'cancelled', 'create_time': 'yesterday'}]
        self.assertNotEqual(self.runtime.revisions(old), self.runtime.revisions(new))

    def test_busy_and_pending_never_queue_duplicate(self):
        for busy, pending in [(True, False), (False, True), (True, True)]:
            self.assertEqual(self.runtime.dispatch_reason(True, True, busy, pending), None)

    def test_delivery_unblocks_work_but_idle_skips(self):
        self.assertEqual(self.runtime.dispatch_reason(True, False, False, False), 'changed_messages')
        self.assertEqual(self.runtime.dispatch_reason(False, True, False, False), 'unfinished_work')
        self.assertIsNone(self.runtime.dispatch_reason(False, False, False, False))

    def test_new_delivery_seen_while_busy_stays_pending(self):
        dirty = self.runtime.retain_changes({}, {'delivery': 'v2'}, {'delivery': 'v1'})
        self.assertEqual(self.runtime.retain_changes(dirty, {'delivery': 'v2'}, {'delivery': 'v2'}), {'delivery': 'v2'})

    def test_incomplete_or_wrong_identity_fails_closed(self):
        for response in [{'ok': False}, {'ok': True, 'identity': 'bot', 'data': {'messages': [], 'has_more': False}},
                         {'ok': True, 'identity': 'user', 'data': {'messages': [], 'has_more': True}}]:
            with self.assertRaises(ValueError):
                self.runtime.validate_history(response)

    def test_pending_requires_own_turn_completion(self):
        pending = {'marker': 'unique-tick', 'queued_at': '2026-10-06T10:00:00Z'}
        unrelated = [{'timestamp': '2026-10-06T10:01:00Z', 'type': 'event_msg', 'payload': {'type': 'task_complete'}}]
        self.assertFalse(self.runtime.pending_finished(pending, unrelated))
        accepted = {'timestamp': '2026-10-06T10:02:00Z', 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'unique-tick'}]}}
        self.assertFalse(self.runtime.pending_finished(pending, unrelated + [accepted]))
        finished = {'timestamp': '2026-10-06T10:03:00Z', 'type': 'event_msg', 'payload': {'type': 'task_complete'}}
        self.assertTrue(self.runtime.pending_finished(pending, unrelated + [accepted, finished]))

    def test_unrelated_turn_does_not_complete_accepted_round(self):
        pending = {'marker': 'our-tick', 'queued_at': '2026-10-06T10:00:00Z'}
        records = [
            {'timestamp': '2026-10-06T10:01:00Z', 'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'ours'}},
            {'timestamp': '2026-10-06T10:01:01Z', 'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': 'our-tick'}]}},
            {'timestamp': '2026-10-06T10:02:00Z', 'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'other'}}]
        self.assertFalse(self.runtime.pending_finished(pending, records))


    def test_marker_before_first_start_binds_turn(self):
        pending = {'marker': 'our-tick', 'queued_at': '2026-10-06T10:00:00Z'}
        records = [
            {'timestamp': '2026-10-06T10:01:00Z', 'payload': {'type': 'message', 'role': 'user', 'content': [{'text': 'our-tick'}]}},
            {'timestamp': '2026-10-06T10:01:01Z', 'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'ours'}},
            {'timestamp': '2026-10-06T10:02:00Z', 'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'ours'}}]
        self.assertTrue(self.runtime.pending_finished(pending, records))

if __name__ == '__main__':
    unittest.main()
