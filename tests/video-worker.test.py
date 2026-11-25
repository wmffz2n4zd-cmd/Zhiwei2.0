import importlib.util
import json
import os
import pathlib
import socket
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parent.parent / 'scripts/video-worker.py'
spec = importlib.util.spec_from_file_location('worker', SOURCE)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class VideoWorkerTests(unittest.TestCase):
    def test_canonical_sources(self):
        self.assertEqual(w.canonical_url('https://youtu.be/jNQXAC9IVRw?token=never-sent')['url'], 'https://www.youtube.com/watch?v=jNQXAC9IVRw')
        self.assertEqual(w.canonical_url('https://www.bilibili.com/video/BV1xx411c7mD?p=2')['part'], 2)
        for url in ['http://youtube.com/watch?v=jNQXAC9IVRw', 'https://localhost/video/BV1xx411c7mD', 'https://evil.youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com/playlist?list=test']:
            with self.assertRaises(w.VideoError): w.canonical_url(url)

    def test_public_network_guard(self):
        for address in ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2002:808:808::1', '3fff::1', '100.64.1.1', '224.0.0.1']:
            self.assertFalse(w.public_ip(address), address)
        self.assertTrue(w.public_ip('8.8.8.8'))
        self.assertFalse(w.allowed_host('youtube.com.evil.test'))
        self.assertTrue(w.allowed_host('rr3---sn-test.googlevideo.com'))

    def test_dns_rebinding_private_final_connect_is_refused(self):
        original = socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex
        try:
            with patch('socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 443))]):
                w.install_network_guard()
                self.assertEqual(socket.getaddrinfo('www.youtube.com', 443)[0][4][0], '8.8.8.8')
                with socket.socket() as sock:
                    with self.assertRaises(w.VideoError): sock.connect(('169.254.169.254', 443))
                    with self.assertRaises(w.VideoError): sock.connect_ex(('127.0.0.1', 443))
                with self.assertRaises(w.VideoError): socket.getaddrinfo('evil.test', 443)
        finally:
            socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex = original

    def test_timestamp_subtitles_and_html_are_normalized_without_inventing_cues(self):
        cues = w.subtitle_cues('WEBVTT\n\n00:01.000 --> 00:03.000\n<c>Blue &amp; red</c>\n\n00:10.000 --> 00:11.000\nnot in video', 'vtt', 5)
        self.assertEqual(cues, [{'start': 1.0, 'end': 3.0, 'text': 'Blue & red'}])
        bilibili = w.subtitle_cues(json.dumps({'body': [{'from': 0, 'to': 2, 'content': '实际字幕'}]}), 'json', 5)
        self.assertEqual(bilibili[0]['text'], '实际字幕')

    def test_track_selection_never_uses_danmaku_or_unknown_languages_as_subtitles(self):
        self.assertIsNone(w.select_track({'subtitles': {'danmaku': [{'url': 'https://example.com/x', 'ext': 'json'}]}}))
        self.assertEqual(w.select_track({'subtitles': {'en': [{'url': 'https://youtube.com/x', 'ext': 'vtt'}]}, 'automatic_captions': {'zh': [{'url': 'https://youtube.com/y', 'ext': 'vtt'}]}})['kind'], 'human')

    def test_anon_youtube_needs_public_status_and_no_platform_accepts_known_nonpublic_media(self):
        w.require_public_metadata({'availability': 'public'}, 'youtube')
        for data, platform in [({}, 'youtube'), ({'availability': 'unlisted'}, 'youtube'),
                               ({'availability': 'subscriber_only'}, 'bilibili'), ({'age_limit': 18}, 'bilibili')]:
            with self.assertRaises(w.VideoError) as error:
                w.require_public_metadata(data, platform)
            self.assertEqual(error.exception.code, 'source_restricted')

    def test_trailing_and_submillisecond_cues_do_not_invalidate_good_media(self):
        raw = json.dumps({'body': [
            {'from': 45, 'to': 47.2, 'content': 'clip to actual duration'},
            {'from': 47.1, 'to': 47.6, 'content': 'outside'},
            {'from': 15.00001, 'to': 15.00002, 'content': 'collapses on rounding'}]})
        self.assertEqual(w.subtitle_cues(raw, 'json', 47),
                         [{'start': 45, 'end': 47, 'text': 'clip to actual duration'}])

    def test_media_file_magic_rejects_playlists_before_ffmpeg(self):
        with tempfile.TemporaryDirectory() as td:
            p = pathlib.Path(td); (p/'attack.mp4').write_text('#EXTM3U\nfile:///etc/passwd')
            with self.assertRaises(w.VideoError): w.frames_from_file(p/'attack.mp4', p, p)

    def test_source_failures_are_sanitized(self):
        self.assertEqual(w.safe_failure(Exception('Sign in to confirm you are not a bot token=secret')), 'source_restricted')
        self.assertEqual(w.safe_failure(Exception('HTTP Error 412: Precondition Failed')), 'source_restricted')
        self.assertEqual(w.safe_failure(Exception('path=/private/user key=secret')), 'source_fetch_failed')


if __name__ == '__main__': unittest.main()
