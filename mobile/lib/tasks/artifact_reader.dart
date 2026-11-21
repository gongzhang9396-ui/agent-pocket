import 'dart:convert';
import 'dart:io';

typedef ArtifactRpc = Future<dynamic> Function(String method, [Map<String, dynamic> params]);

class ArtifactCancelled implements Exception {}

/// Writes verified chunks into a caller-owned temporary file. The caller must
/// close/remove the partial file on failure and use the system picker to save.
class ArtifactReader {
  ArtifactReader(this.read);
  final ArtifactRpc read;
  static const maxBytes = 32 * 1024 * 1024;
  static const chunkBytes = 192 * 1024;

  Future<List<Map<String, dynamic>>> list(String threadId, {String? cursor}) async {
    _validateId(threadId);
    if (cursor != null && (cursor.trim().isEmpty || cursor.length > 4096)) throw const FormatException('历史游标无效');
    final params = <String, dynamic>{'threadId': threadId};
    if (cursor != null) { params['cursor'] = cursor; }
    final result = await read('artifact/list', params);
    if (result is! Map || result['data'] is! List) throw const FormatException('文件列表格式无效');
    final output = <Map<String, dynamic>>[];
    for (final item in result['data'] as List) {
      if (item is! Map<String, dynamic> || item['name'] is! String || item['mimeType'] is! String ||
          item['messageId'] is! String || item['source'] is! String ||
          item['size'] is! int || (item['size'] as int) < 0 || (item['size'] as int) > maxBytes ||
          item['id'] is! String || (item['id'] as String).length > 100) { throw const FormatException('文件资料无效'); }
      if ((item['id'] as String).isEmpty && item['unavailable'] is! String) throw const FormatException('文件标识缺失');
      final messageId = item['messageId'] as String, source = item['source'] as String;
      if (messageId.isEmpty || messageId.length > 256 || source.isEmpty || source.length > 4096 ||
          messageId.contains('\u0000') || source.contains('\u0000')) { throw const FormatException('文件引用无效'); }
      output.add(Map.unmodifiable(item));
    }
    return List.unmodifiable(output);
  }

  Future<void> download(String threadId, Map<String, dynamic> artifact, RandomAccessFile output,
      {bool Function()? cancelled, void Function(int bytes, int total)? onProgress}) async {
    _validateId(threadId);
    final id = artifact['id'];
    final size = artifact['size'];
    if (id is! String || id.isEmpty || id.length > 100 || size is! int || size < 0 || size > maxBytes ||
        artifact['unavailable'] != null) { throw const FormatException('文件不可读取'); }
    if (cancelled?.call() == true) throw ArtifactCancelled();
    await output.truncate(0);
    await output.setPosition(0);
    var offset = 0;
    do {
      if (cancelled?.call() == true) throw ArtifactCancelled();
      final chunk = await read('artifact/read', {'threadId': threadId, 'id': id, 'offset': offset});
      if (cancelled?.call() == true) throw ArtifactCancelled();
      if (chunk is! Map || chunk['id'] != id || chunk['offset'] != offset || chunk['size'] != size ||
          chunk['data'] is! String || (chunk['data'] as String).length > 262144) {
        throw const FormatException('文件已变化，请重新载入');
      }
      final encoded = chunk['data'] as String;
      if (!RegExp(r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$').hasMatch(encoded)) {
        throw const FormatException('文件数据编码无效');
      }
      final bytes = base64.decode(encoded);
      if (base64.encode(bytes) != encoded || bytes.length > chunkBytes || chunk['nextOffset'] != offset + bytes.length ||
          offset + bytes.length > size || chunk['done'] != (offset + bytes.length == size) ||
          (bytes.isEmpty && offset != size)) { throw const FormatException('文件分块无效或已变化'); }
      await output.writeFrom(bytes);
      offset += bytes.length;
      onProgress?.call(offset, size);
    } while (offset < size);
    await output.flush();
  }

  void _validateId(String id) {
    if (id.isEmpty || id.length > 100) throw const FormatException('任务标识无效');
  }
}
