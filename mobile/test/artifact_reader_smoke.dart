// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import '../lib/tasks/artifact_reader.dart';

Future<void> main() async {
  final temporary = await Directory.systemTemp.createTemp('pocket-artifact-test-');
  final file = File('${temporary.path}${Platform.pathSeparator}test.tmp');
  final bytes = Uint8List.fromList(List.generate(200000, (index) => index % 251));
  var calls = 0;
  var corrupt = false;
  final reader = ArtifactReader((method, [params = const {}]) async {
    if (method == 'artifact/list') { return {'data': [{'id': 'file', 'name': 'file.txt', 'mimeType': 'text/plain',
      'size': bytes.length, 'messageId': 'turn:reply', 'source': 'file.txt'}]}; }
    assert(method == 'artifact/read' && params['threadId'] == 'thread');
    calls++;
    final start = params['offset'] as int;
    final end = (start + ArtifactReader.chunkBytes).clamp(0, bytes.length);
    return {'id': 'file', 'offset': start, 'size': bytes.length, 'data': base64.encode(bytes.sublist(start, end)),
      'nextOffset': corrupt ? end + 1 : end, 'done': end == bytes.length};
  });
  final descriptor = (await reader.list('thread')).single;
  var output = await file.open(mode: FileMode.write);
  var progress = 0;
  await reader.download('thread', descriptor, output, onProgress: (sent, _) => progress = sent);
  await output.close();
  final result = await file.readAsBytes();
  assert(calls == 2 && progress == bytes.length && base64.encode(result) == base64.encode(bytes));
  corrupt = true;
  output = await file.open(mode: FileMode.write);
  try { await reader.download('thread', descriptor, output); throw StateError('corrupt chunk accepted'); }
  on FormatException { /* No invalid chunk is written. */ }
  await output.close();
  assert(await file.length() == 0);
  output = await file.open(mode: FileMode.write);
  try { await reader.download('thread', descriptor, output, cancelled: () => true); throw StateError('cancellation ignored'); }
  on ArtifactCancelled { /* The owner decides how to remove a partial file. */ }
  await output.close();
  await file.delete();
  await temporary.delete();
  print('artifact reader contract passed');
}
