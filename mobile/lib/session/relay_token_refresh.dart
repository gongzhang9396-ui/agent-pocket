import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'session_manager.dart';

/// Sends exactly one refresh request. A timeout or socket error after starting
/// the request is intentionally treated as an unknown outcome by the session
/// manager, because refresh tokens are single use.
class RelayTokenRefresh {
  RelayTokenRefresh({HttpClient Function()? clientFactory, this.timeout = const Duration(seconds: 30)})
      : _clientFactory = clientFactory ?? HttpClient.new;
  final HttpClient Function() _clientFactory;
  final Duration timeout;
  static const _maxResponseBytes = 64 * 1024;

  Future<Map<String, dynamic>> call(Map<String, dynamic> credentials) async {
    final endpoint = credentials['endpoint'];
    final token = credentials['refreshToken'];
    if (endpoint is! String || token is! String || token.isEmpty) throw RefreshNotSent();
    final base = Uri.tryParse(endpoint);
    if (base == null || base.scheme != 'https' || base.host.isEmpty || base.userInfo.isNotEmpty ||
        base.hasQuery || base.hasFragment) {
      throw RefreshNotSent();
    }
    final uri = Uri.parse('${base.toString().replaceFirst(RegExp(r'/+$'), '')}/api/auth/refresh');
    final client = _clientFactory();
    client.connectionTimeout = const Duration(seconds: 20);
    try {
      return await _send(client, uri, token).timeout(timeout);
    } finally {
      client.close(force: true);
    }
  }

  Future<Map<String, dynamic>> _send(HttpClient client, Uri uri, String token) async {
    final request = await client.postUrl(uri);
    request.followRedirects = false;
    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({'refreshToken': token}));
    final response = await request.close();
    if (response.statusCode == HttpStatus.unauthorized) throw AccessRejected();
    if (response.statusCode != HttpStatus.ok) throw HttpException('登录续期暂时失败 (${response.statusCode})');
    try {
      final bytes = <int>[];
      await for (final part in response) {
        if (bytes.length + part.length > _maxResponseBytes) throw const FormatException('响应过大');
        bytes.addAll(part);
      }
      final value = jsonDecode(utf8.decode(bytes));
      if (value is! Map<String, dynamic>) throw const FormatException('响应格式错误');
      for (final key in ['accessToken', 'refreshToken']) {
        if (value[key] is! String || (value[key] as String).isEmpty) throw const FormatException('凭据缺失');
      }
      for (final key in ['accessExpiresAt', 'refreshExpiresAt']) {
        if (value[key] is! int) throw const FormatException('期限缺失');
      }
      return value;
    } on FormatException {
      // An HTTP 200 can already have consumed the old refresh token.
      throw RefreshConsumed();
    }
  }
}
