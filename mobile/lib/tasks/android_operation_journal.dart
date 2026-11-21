import 'dart:convert';
import 'package:flutter/services.dart';
import 'operation_runner.dart';

class AndroidOperationJournal implements OperationJournal {
  static const channel = MethodChannel('agent_pocket/secure_state');
  @override Future<List<Map<String, dynamic>>> load(String scope) async {
    final value = await channel.invokeMethod<String>('read', {'key': 'operations:$scope'});
    if (value == null) return [];
    final result = jsonDecode(value);
    if (result is! List || result.length > 100 || result.any((item) => item is! Map<String, dynamic> || item['operationId'] is! String)) {
      throw const FormatException('未完成操作记录无法读取，请保留设备数据并恢复');
    }
    return result.cast<Map<String, dynamic>>();
  }
  @override Future<void> save(String scope, List<Map<String, dynamic>> operations) => channel.invokeMethod<void>('write', {
    'key': 'operations:$scope', 'json': jsonEncode(operations)});
}
