import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'operation_runner.dart';
import '../protocol/rpc_client.dart';

const attachmentChunkSize = 192 * 1024;
const attachmentMaxSize = 20 * 1024 * 1024;
class UploadCancelled implements Exception {}
class PickedAttachment {
  PickedAttachment({required this.path, required this.filename, required this.mimeType, required this.size, required this.sha256,
    String? slot, String? token, this.id}) : slot = slot ?? newOperationId(), token = token ?? _newToken();
  factory PickedAttachment.fromJson(Map<String, dynamic> json) => PickedAttachment(path: json['path'] as String,
    filename: json['filename'] as String, mimeType: json['mimeType'] as String, size: json['size'] as int,
    sha256: json['sha256'] as String, slot: json['slot'] as String?, token: json['token'] as String?, id: json['id'] as String?);
  final String path, filename, mimeType, sha256, slot, token;
  final int size;
  String? id;
  Map<String, dynamic> toJson() => {'path': path, 'filename': filename, 'mimeType': mimeType, 'size': size,
    'sha256': sha256, 'slot': slot, 'token': token, if (id != null) 'id': id};
  static String _newToken() { final random = Random.secure(); return base64Url.encode(List.generate(32, (_) => random.nextInt(256))).replaceAll('=', ''); }
}

/// Each begin has a stable client nonce. Unknown chunk acknowledgements are
/// resolved with status on the next explicit attempt, never by blind replay.
class AttachmentUploader {
  AttachmentUploader({required this.read, required this.write, required this.persist});
  final OperationCall read, write;
  final Future<void> Function() persist;

  Future<List<Map<String, dynamic>>> upload(String operationId, Map<String, dynamic> target, List<PickedAttachment> files,
      {bool Function()? cancelled, void Function(int bytes, int total)? progress}) async {
    if (files.isEmpty || files.length > 3 || files.any((file) => file.size < 1 || file.size > attachmentMaxSize) ||
        files.fold(0, (int total, file) => total + file.size) > 60 * 1024 * 1024) { throw const FormatException('每次最多 3 个附件，单个 20 MiB'); }
    var completed = 0;
    final total = files.fold(0, (int sum, file) => sum + file.size);
    final refs = <Map<String, dynamic>>[];
    for (final file in files) {
      void check() { if (cancelled?.call() == true) throw UploadCancelled(); }
      check();
      final source = File(file.path), before = await File(file.path).stat();
      if (before.type != FileSystemEntityType.file || before.size != file.size || await FileSystemEntity.isLink(file.path)) {
        throw const FormatException('所选文件已变化，请重新选择');
      }
      final digest = await sha256.bind(source.openRead()).first;
      if (digest.toString() != file.sha256) throw const FormatException('所选文件已变化，请重新选择');
      check();
      dynamic status;
      if (file.id != null) {
        try { status = await read('attachment/status', {'id': file.id, 'token': file.token}); }
        on RpcException catch (error) { if (error.code != 'NOT_FOUND') rethrow; file.id = null; await persist(); }
      }
      if (file.id == null) {
        status = await write('attachment/begin', {...target, 'operationId': operationId, 'slot': file.slot, 'token': file.token,
          'filename': file.filename, 'mimeType': file.mimeType, 'size': file.size, 'sha256': file.sha256});
        if (status is! Map || status['id'] is! String) throw const FormatException('附件响应无效');
        file.id = status['id'] as String; await persist();
      }
      if (status is! Map || status['id'] != file.id || status['size'] != file.size || status['sha256'] != file.sha256 ||
          status['offset'] is! int || (status['offset'] as int) < 0 || (status['offset'] as int) > file.size || status['committed'] == true) {
        throw const FormatException('附件续传状态无效，请查询发送回执');
      }
      final input = await source.open();
      var offset = status['offset'] as int;
      try {
        while (offset < file.size) {
          check(); await input.setPosition(offset);
          final bytes = await input.read(min(attachmentChunkSize, file.size - offset));
          if (bytes.length != min(attachmentChunkSize, file.size - offset)) throw const FormatException('文件读取未完成');
          final result = await write('attachment/write', {'id': file.id, 'token': file.token, 'offset': offset, 'data': base64.encode(bytes)});
          if (result is! Map || result['id'] != file.id || result['offset'] != offset + bytes.length) throw const FormatException('附件分块回执无效');
          offset += bytes.length; progress?.call(completed + offset, total);
        }
      } finally { await input.close(); }
      check();
      final after = await source.stat();
      if (after.size != before.size || after.modified != before.modified || after.changed != before.changed) throw const FormatException('上传期间文件已变化');
      final finished = await write('attachment/finish', {'id': file.id, 'token': file.token});
      if (finished is! Map || finished['ready'] != true || finished['id'] != file.id || finished['sha256'] != file.sha256) {
        throw const FormatException('电脑端文件校验未完成');
      }
      refs.add({'id': file.id, 'token': file.token}); completed += file.size; progress?.call(completed, total);
    }
    return refs;
  }
  Future<void> abort(List<PickedAttachment> files) async {
    for (final file in files) { if (file.id != null) await write('attachment/abort', {'id': file.id, 'token': file.token}); }
  }
}
