import 'package:flutter/services.dart';
import 'attachment_uploader.dart';

class NativeFiles {
  static const channel = MethodChannel('agent_pocket/files');
  static Future<List<PickedAttachment>> pick() async {
    final values = await channel.invokeListMethod<dynamic>('pick') ?? [];
    return values.map((item) => PickedAttachment.fromJson(Map<String, dynamic>.from(item as Map))).toList();
  }
  static Future<void> remove(PickedAttachment file) => channel.invokeMethod<void>('remove', {'path': file.path});
}
