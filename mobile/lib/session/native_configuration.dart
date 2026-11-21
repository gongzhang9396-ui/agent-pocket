import 'package:flutter/services.dart';

class NativeConfiguration {
  static const channel = MethodChannel('agent_pocket/configuration');
  static Future<Map<String, dynamic>> read() async => Map<String, dynamic>.from(await channel.invokeMapMethod<String, dynamic>('read') ?? {});
}
