import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter/foundation.dart';
import 'package:sodium/sodium_sumo.dart';
import '../session/native_configuration.dart';
import '../session/pocket_session_service.dart';
import '../session/relay_http.dart';
import '../session/session_manager.dart';

class _DigestResult implements Sink<Digest> {
  Digest? value;
  @override void add(Digest data) { value = data; }
  @override void close() {}
}
class AvailableUpdate {
  const AvailableUpdate(this.version, this.versionCode, this.name, this.size, this.sha256, this.download, this.manifestJson);
  final String version, name, sha256, manifestJson;
  final int versionCode, size;
  final Uri download;
}

class AppUpdate {
  AppUpdate(this.service);
  final PocketSessionService service;
  static const platform = MethodChannel('agent_pocket/update');
  bool _busy = false;
  Future<AvailableUpdate?> check() async {
    if (defaultTargetPlatform != TargetPlatform.android) {
      throw UnsupportedError('iOS 测试版本请通过电脑安装更新');
    }
    final config = await NativeConfiguration.read(), ref = await service.sessions.snapshot();
    final response = await RelayHttp().authenticatedRead(service.sessions, ref, '/api/updates/android/latest');
    if (!service.sessions.isCurrent(ref)) throw SessionChanged();
    return verify(response, config, ref.credentials['endpoint'] as String, service.sodium);
  }
  static AvailableUpdate? verify(Map<String, dynamic> response, Map<String, dynamic> config, String endpoint, SodiumSumo sodium) {
    final raw = response['manifestJson'], signature = response['manifestSignature'];
    if (raw is! String || utf8.encode(raw).length > 256 * 1024 || signature is! String || config['updatePublicKeySpki'] is! String) {
      throw const FormatException('更新清单或验证公钥缺失');
    }
    final spki = base64.decode(config['updatePublicKeySpki'] as String), sig = base64.decode(signature);
    const prefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
    if (spki.length != 44 || sig.length != 64 || !Iterable.generate(prefix.length).every((index) => spki[index] == prefix[index]) ||
        !sodium.crypto.sign.verifyDetached(message: Uint8List.fromList(utf8.encode(raw)), signature: Uint8List.fromList(sig), publicKey: Uint8List.fromList(spki.sublist(12)))) {
      throw const FormatException('更新清单签名无效');
    }
    final manifest = jsonDecode(raw), uri = Uri.tryParse(response['downloadUrl'] as String? ?? ''), base = Uri.parse(endpoint);
    if (manifest is! Map || manifest['schemaVersion'] != 1 || manifest['platform'] != 'android' || manifest['version'] is! String ||
        !RegExp(r'^\d+\.\d+\.\d+$').hasMatch(manifest['version'] as String) || manifest['versionCode'] is! int || manifest['asset'] is! Map) {
      throw const FormatException('更新清单格式无效');
    }
    final version = manifest['version'] as String, code = manifest['versionCode'] as int, asset = manifest['asset'] as Map;
    final name = 'Agent-Pocket-$version-release.apk', size = asset['size'], digest = asset['sha256'];
    if (asset['name'] != name || size is! int || size < 1 || size > 250 * 1024 * 1024 || digest is! String || !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(digest) ||
        uri == null || uri.scheme != 'https' || uri.origin != base.origin || uri.userInfo.isNotEmpty || uri.hasQuery || uri.hasFragment ||
        !uri.path.startsWith('${base.path.replaceFirst(RegExp(r'/+$'), '')}/api/updates/android/') || uri.pathSegments.last != name ||
        uri.pathSegments.contains('..') || uri.pathSegments.contains('.')) {
      throw const FormatException('更新资产地址或大小无效');
    }
    final current = (config['version'] as String).split('.').map(int.parse).toList(), next = version.split('.').map(int.parse).toList();
    var newer = false;
    for (var index = 0; index < 3; index++) { if (next[index] != current[index]) { newer = next[index] > current[index]; break; } }
    if (code <= (config['versionCode'] as int) || !newer) return null;
    return AvailableUpdate(version, code, name, size, digest.toLowerCase(), uri, raw);
  }
  Future<void> downloadAndInstall(AvailableUpdate update, {bool Function()? cancelled, void Function(int, int)? progress}) async {
    if (defaultTargetPlatform != TargetPlatform.android) {
      throw UnsupportedError('iOS 测试版本请通过电脑安装更新');
    }
    if (_busy) throw StateError('更新正在进行'); _busy = true;
    Directory? directory;
    try {
      final ref = await service.sessions.snapshot();
      directory = await Directory.systemTemp.createTemp('pocket-update-');
      final file = File('${directory.path}${Platform.pathSeparator}update.apk');
      await service.sessions.read(ref, (credentials) async {
        final client = HttpClient()..connectionTimeout = const Duration(seconds: 20);
        RandomAccessFile? output;
        try {
          final request = await client.getUrl(update.download); request.followRedirects = false;
          request.headers.set(HttpHeaders.authorizationHeader, 'Bearer ${credentials['accessToken']}');
          final response = await request.close().timeout(const Duration(seconds: 40));
          if (response.statusCode == 401) throw AccessRejected();
          if (response.statusCode != 200 || response.contentLength != -1 && response.contentLength != update.size) throw const FormatException('更新下载响应无效');
          output = await file.open(mode: FileMode.write);
          final result = _DigestResult();
          final sink = sha256.startChunkedConversion(result);
          var length = 0;
          await for (final chunk in response.timeout(const Duration(seconds: 40))) {
            if (cancelled?.call() == true || !service.sessions.isCurrent(ref)) throw SessionChanged();
            length += chunk.length; if (length > update.size) throw const FormatException('更新文件超出清单大小');
            sink.add(chunk); await output.writeFrom(chunk); progress?.call(length, update.size);
          }
          sink.close(); await output.flush(); await output.close(); output = null;
          if (length != update.size || result.value.toString() != update.sha256) throw const FormatException('更新文件大小或 SHA-256 校验失败');
        } finally { await output?.close(); client.close(force: true); }
      });
      if (!service.sessions.isCurrent(ref) || cancelled?.call() == true) throw SessionChanged();
      final accepted = await platform.invokeMethod<bool>('install', {'path': file.path, 'versionCode': update.versionCode, 'version': update.version, 'sha256': update.sha256, 'size': update.size});
      if (accepted != true) throw StateError('请允许本应用安装更新后重新检查更新');
      // The system installer reads through a content URI after this method
      // returns. Its bounded cache file is retained for that asynchronous read.
      directory = null;
    } finally {
      if (directory != null) {
        final file = File('${directory.path}${Platform.pathSeparator}update.apk');
        try { if (await file.exists()) await file.delete(); await directory.delete(); } catch (_) {}
      }
      _busy = false;
    }
  }
}
