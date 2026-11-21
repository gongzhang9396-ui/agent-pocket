import 'dart:convert';
import '../tasks/android_operation_journal.dart';
import 'device_enrollment.dart';

class AndroidEnrollmentStore implements EnrollmentStore {
  @override Future<Map<String, dynamic>?> load() async {
    final raw = await AndroidOperationJournal.channel.invokeMethod<String>('read', {'key': 'provisional-login'});
    if (raw == null || raw == '{}') return null;
    final data = jsonDecode(raw);
    if (data is! Map<String, dynamic> || data['deviceSigningPrivateKey'] is! String) throw const FormatException('未完成注册身份无法读取，请保留应用数据');
    return data;
  }
  @override Future<void> save(Map<String, dynamic> provisional) => AndroidOperationJournal.channel.invokeMethod<void>('write', {
    'key': 'provisional-login', 'json': jsonEncode(provisional)});
}
