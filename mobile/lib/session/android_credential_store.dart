import 'dart:convert';
import 'package:flutter/services.dart';
import 'session_manager.dart';

class AndroidCredentialStore implements CredentialStore {
  static const _channel = MethodChannel('agent_pocket/credential_store');
  static Future<Map<String, dynamic>?> readPendingHost() async {
    final raw = await _channel.invokeMethod<String>('readPendingHost');
    if (raw == null) return null;
    final value = jsonDecode(raw);
    if (value is! Map<String, dynamic>) throw const FormatException('待绑定电脑记录无法读取');
    return value;
  }
  static Future<void> savePendingHost(Map<String, dynamic> value) => _channel.invokeMethod<void>('writePendingHost', {'json': jsonEncode(value)});
  static Future<void> clearPendingHost() => _channel.invokeMethod<void>('clearPendingHost');
  @override
  Future<bool> isBlocked() async => await _channel.invokeMethod<bool>('isBlocked') ?? true;
  @override
  Future<void> block() => _channel.invokeMethod<void>('block');
  @override
  Future<Map<String, dynamic>?> load() async {
    final value = await _channel.invokeMethod<String>('read');
    if (value == null) return null;
    final decoded = jsonDecode(value);
    if (decoded is! Map<String, dynamic>) throw const FormatException('设备凭据格式无效');
    return decoded;
  }
  @override
  Future<void> save(Map<String, dynamic> credentials) => _channel.invokeMethod<void>('write', {'json': jsonEncode(credentials)});
  @override
  Future<void> clearCredentials() => _channel.invokeMethod<void>('clear');
}
