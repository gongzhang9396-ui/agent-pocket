import 'dart:convert';
import 'dart:math';

String newOperationId() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

abstract interface class OperationJournal {
  Future<List<Map<String, dynamic>>> load(String scope);
  Future<void> save(String scope, List<Map<String, dynamic>> operations);
}
class OperationUncertain implements Exception {
  const OperationUncertain(this.operation);
  final Map<String, dynamic> operation;
  @override String toString() => '结果待确认，操作没有自动重发。请检查原操作回执。';
}
class OperationFailed implements Exception {
  const OperationFailed(this.message);
  final String message;
  @override String toString() => message;
}

typedef OperationCall = Future<dynamic> Function(String method, Map<String, dynamic> params);

/// Durable write intent before the first network byte; recovery only queries
/// receipts and never reconstructs/repeats the original mutation.
class OperationRunner {
  OperationRunner(this.journal);
  final OperationJournal journal;
  final Set<String> _busy = {};
  Future<List<Map<String, dynamic>>> pending(String scope) => journal.load(scope);

  Future<dynamic> run(String scope, String method, Map<String, dynamic> params, OperationCall send, OperationCall read,
      {String? operationId, bool retainSuccess = false, bool Function(Object error)? definitelyNotSent}) async {
    if (!_busy.add(scope)) throw StateError('电脑正在处理另一个操作');
    try {
      final previous = await journal.load(scope);
      final target = params['threadId'];
      if (previous.any((entry) => entry['threadId'] == target)) throw OperationUncertain(previous.firstWhere((entry) => entry['threadId'] == target));
      final id = operationId ?? newOperationId();
      final record = <String, dynamic>{'operationId': id, 'method': method, 'threadId': ?target,
        'createdAt': DateTime.now().millisecondsSinceEpoch};
      await journal.save(scope, [...previous, record]);
      try {
        final result = await send(method, {...params, 'operationId': id, 'clientMessageId': id});
        if (!retainSuccess) { try { await _remove(scope, id); } catch (_) { throw OperationUncertain(record); } }
        return result;
      } catch (error) {
        if (definitelyNotSent?.call(error) == true) { await _remove(scope, id); rethrow; }
        return await recover(scope, record, read, retainSuccess: retainSuccess);
      }
    } finally { _busy.remove(scope); }
  }
  Future<dynamic> recover(String scope, Map<String, dynamic> record, OperationCall read, {bool retainSuccess = false}) async {
    dynamic receipt;
    try { receipt = await read('operation/get', {'operationId': record['operationId']}); }
    catch (_) { throw OperationUncertain(record); }
    if (receipt is! Map || receipt['operationId'] != record['operationId']) throw OperationUncertain(record);
    if (receipt['status'] == 'succeeded') {
      if (!retainSuccess) { try { await _remove(scope, record['operationId'] as String); } catch (_) { throw OperationUncertain(record); } }
      return receipt['result'];
    }
    if (receipt['status'] == 'failed') {
      try { await _remove(scope, record['operationId'] as String); } catch (_) { throw OperationUncertain(record); }
      final error = receipt['error'];
      throw OperationFailed(error is Map && error['message'] is String ? error['message'] as String : '电脑确认操作未成功，请检查任务状态后重新操作');
    }
    // A missing receipt can race a delayed dispatch; it is not proof of failure.
    throw OperationUncertain(record);
  }
  /// A batch acknowledges success only after its outer transport/session
  /// checks and local draft commit have completed.
  Future<void> confirm(String scope, String id) async {
    final record = (await journal.load(scope)).where((item) => item['operationId'] == id).firstOrNull;
    if (record == null) return;
    try { await _remove(scope, id); } catch (_) { throw OperationUncertain(record); }
  }
  Future<void> _remove(String scope, String id) async {
    final records = await journal.load(scope);
    await journal.save(scope, records.where((record) => record['operationId'] != id).toList());
  }
  static String scope(Map<String, dynamic> credentials, String hostId) => jsonEncode([
    credentials['endpoint'], credentials['accountId'], credentials['deviceId'], hostId]);
}
