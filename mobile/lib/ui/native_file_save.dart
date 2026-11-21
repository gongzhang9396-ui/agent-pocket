import 'package:flutter/services.dart';

class NativeFileSave {
  static const _channel = MethodChannel('agent_pocket/file_save');
  static Future<bool> save(String path, String name, String mimeType) async =>
      await _channel.invokeMethod<bool>('save', {'path': path, 'name': name, 'mimeType': mimeType}) ?? false;
}
