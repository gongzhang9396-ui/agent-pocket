import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:sodium/sodium_sumo.dart';
import 'relay_encoding.dart';

String _encode(List<int> value) => base64Url.encode(value).replaceAll('=', '');
Uint8List _decode(String value) {
  if (!RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value) || value.length % 4 == 1) throw const FormatException('密钥编码无效');
  final result = Uint8List.fromList(base64Url.decode(base64Url.normalize(value)));
  if (_encode(result) != value) throw const FormatException('密钥编码无效');
  return result;
}
String _string(Map<String, dynamic> value, String name) {
  final result = value[name];
  if (result is! String || result.isEmpty) throw FormatException('通道缺少 $name');
  return result;
}

/// An ordered, authenticated device-to-Host channel. A channel is discarded
/// after transport loss; secretstream state is never reused after reconnect.
class RelayPhoneChannel {
  RelayPhoneChannel._(this._sodium, this._credentials, this._host, this.channelId,
      this._ephemeralPublic, this._pushInput, this._pushOutput, this._pushKey, this._now, this._firstEnvelope);
  final SodiumSumo _sodium;
  final Map<String, dynamic> _credentials;
  final Map<String, dynamic> _host;
  final String channelId;
  final Uint8List _ephemeralPublic;
  final StreamController<SecretStreamPlainMessage> _pushInput;
  final StreamIterator<SecretStreamCipherMessage> _pushOutput;
  final SecureKey _pushKey;
  final int Function() _now;
  Map<String, dynamic>? _firstEnvelope;
  StreamController<SecretStreamCipherMessage>? _pullInput;
  StreamIterator<SecretStreamPlainMessage>? _pullOutput;
  SecureKey? _pullKey;
  Future<void> _pushTail = Future.value();
  Future<void> _pullTail = Future.value();
  int _deviceCounter = 1;
  int _hostCounter = 0;
  bool _closed = false;
  bool _failed = false;
  bool _pushFinished = false;
  bool _pullFinished = false;

  static SecureKey _derive(SodiumSumo sodium, SecureKey secret, Uint8List peer,
      Uint8List context, String direction) {
    final shared = sodium.crypto.scalarmult(n: secret, p: peer);
    Uint8List? derived;
    try {
      derived = sodium.crypto.genericHash.call(message: Uint8List.fromList([...context, ...utf8.encode('\u0000$direction')]), outLen: 32, key: shared);
      return SecureKey.fromList(sodium, derived);
    } finally { shared.dispose(); derived?.fillRange(0, derived.length, 0); }
  }

  static Future<({RelayPhoneChannel channel, Map<String, dynamic> envelope})> open(
      SodiumSumo sodium, Map<String, dynamic> credentials, Map<String, dynamic> host, String channelId,
      {required String firstMessage, int Function()? now}) async {
    if (credentials['deviceStatus'] != 'approved' || credentials['contentKey'] is! String || (credentials['contentKey'] as String).isEmpty || channelId.isEmpty) {
      throw StateError('设备尚未批准');
    }
    final clock = now ?? (() => DateTime.now().millisecondsSinceEpoch);
    final account = _string(credentials, 'accountId');
    final device = _string(credentials, 'deviceId');
    final hostId = _string(host, 'id');
    final firstPlain = Uint8List.fromList(utf8.encode(firstMessage));
    if (firstPlain.length > 1024 * 1024) throw const FormatException('通道消息过大');
    final ephemeral = sodium.crypto.box.keyPair();
    SecureKey? pushKey;
    StreamController<SecretStreamPlainMessage>? input;
    StreamIterator<SecretStreamCipherMessage>? output;
    try {
      pushKey = _derive(sodium, ephemeral.secretKey, _decode(_string(host, 'encryptionPublicKey')),
          transcript(account, hostId, device, channelId), 'device-to-host');
      input = StreamController<SecretStreamPlainMessage>();
      output = StreamIterator(sodium.crypto.secretStream.pushEx(messageStream: input.stream, key: pushKey));
      // sodium emits the stream header alongside its first message, not at
      // initialization. Stage the first real request until the Host accepts.
      final firstMetadata = <String, dynamic>{'accountId': account, 'hostId': hostId,
        'deviceId': device, 'channelId': channelId, 'counter': 1, 'kind': 'channel.data'};
      input.add(SecretStreamPlainMessage(firstPlain, additionalData: relayAad(firstMetadata)));
      if (!await output.moveNext()) throw StateError('无法生成加密通道');
      final header = output.current.message;
      if (header.length != sodium.crypto.secretStream.headerBytes) throw StateError('加密通道头无效');
      if (!await output.moveNext()) throw StateError('无法准备首条通道消息');
      final firstEnvelope = {...firstMetadata, 'ciphertext': _encode(output.current.message)};
      final unsigned = <String, dynamic>{'version': 2, 'accountId': account, 'hostId': hostId,
        'deviceId': device, 'channelId': channelId, 'issuedAt': clock(),
        'ephemeralPublicKey': _encode(ephemeral.publicKey), 'secretstreamHeader': _encode(header)};
      final signBytes = _decode(_string(credentials, 'deviceSigningPrivateKey'));
      final signKey = SecureKey.fromList(sodium, signBytes);
      signBytes.fillRange(0, signBytes.length, 0);
      Uint8List plain;
      try {
        final signature = sodium.crypto.sign.detached(message: handshakeBytes(unsigned), secretKey: signKey);
        plain = Uint8List.fromList(utf8.encode(jsonEncode({...unsigned, 'signature': _encode(signature)})));
      } finally { signKey.dispose(); }
      String ciphertext;
      try { ciphertext = _encode(sodium.crypto.box.seal(message: plain, publicKey: _decode(_string(host, 'encryptionPublicKey')))); }
      finally { plain.fillRange(0, plain.length, 0); }
      final channel = RelayPhoneChannel._(sodium, Map.unmodifiable(credentials), Map.unmodifiable(host), channelId,
        Uint8List.fromList(ephemeral.publicKey), input, output, pushKey, clock, firstEnvelope);
      final envelope = <String, dynamic>{'accountId': account, 'hostId': hostId, 'deviceId': device,
        'channelId': channelId, 'counter': 0, 'kind': 'channel.open', 'ciphertext': ciphertext};
      return (channel: channel, envelope: envelope);
    } catch (_) {
      await output?.cancel();
      unawaited(input?.close() ?? Future<void>.value());
      pushKey?.dispose();
      rethrow;
    } finally { firstPlain.fillRange(0, firstPlain.length, 0); ephemeral.dispose(); }
  }

  bool _matches(Map<String, dynamic> envelope) => envelope['accountId'] == _credentials['accountId'] &&
      envelope['hostId'] == _host['id'] && envelope['deviceId'] == _credentials['deviceId'] && envelope['channelId'] == channelId;

  Future<void> accept(Map<String, dynamic> envelope) async {
    if (_closed || _failed || _pullOutput != null || !_matches(envelope) || envelope['kind'] != 'channel.open' || envelope['counter'] != 0) {
      throw StateError('Host 握手状态无效');
    }
    final bytes = _decode(_string(_credentials, 'deviceEncryptionPrivateKey'));
    final secret = SecureKey.fromList(_sodium, bytes);
    bytes.fillRange(0, bytes.length, 0);
    Uint8List? plaintext;
    try {
      plaintext = _sodium.crypto.box.sealOpen(cipherText: _decode(_string(envelope, 'ciphertext')),
        publicKey: _decode(_string(_credentials, 'deviceEncryptionPublicKey')), secretKey: secret);
      final decoded = jsonDecode(utf8.decode(plaintext));
      if (decoded is! Map<String, dynamic>) throw const FormatException('Host 握手格式无效');
      final signature = _decode(_string(decoded, 'signature'));
      final unsigned = Map<String, dynamic>.from(decoded)..remove('signature');
      final issuedAt = decoded['issuedAt'];
      if (decoded['version'] != 2 || !_matches(decoded) || decoded['deviceEphemeralPublicKey'] != _encode(_ephemeralPublic) ||
          issuedAt is! int || (_now() - issuedAt).abs() > 300000 ||
          !_sodium.crypto.sign.verifyDetached(message: handshakeBytes(unsigned), signature: signature, publicKey: _decode(_string(_host, 'signingPublicKey')))) {
        throw const FormatException('Host 握手签名或身份无效');
      }
      final key = _derive(_sodium, secret, _decode(_string(decoded, 'ephemeralPublicKey')),
        transcript(_string(_credentials, 'accountId'), _string(_host, 'id'), _string(_credentials, 'deviceId'), channelId), 'host-to-device');
      final header = _decode(_string(decoded, 'secretstreamHeader'));
      if (header.length != _sodium.crypto.secretStream.headerBytes) { key.dispose(); throw const FormatException('Host 通道头无效'); }
      final input = StreamController<SecretStreamCipherMessage>();
      final output = StreamIterator(input.stream.transform(_sodium.crypto.secretStream.createPullEx(key, requireFinalized: false)));
      _pullKey = key; _pullInput = input; _pullOutput = output;
      input.add(SecretStreamCipherMessage(header));
    } catch (_) { _failed = true; rethrow; }
    finally { plaintext?.fillRange(0, plaintext.length, 0); secret.dispose(); }
  }

  Future<T> _serial<T>(bool push, Future<T> Function() operation) async {
    final previous = push ? _pushTail : _pullTail;
    final release = Completer<void>();
    if (push) { _pushTail = release.future; } else { _pullTail = release.future; }
    await previous;
    try { if (_closed || _failed) throw StateError('加密通道已关闭'); return await operation(); }
    finally { release.complete(); }
  }

  Future<Map<String, dynamic>> encrypt(String text, {bool finalMessage = false}) => _serial(true, () async {
    if (_pullOutput == null) throw StateError('Host 尚未完成握手');
    if (_firstEnvelope != null) throw StateError('必须先发送握手中准备的第一条消息');
    if (_pushFinished) throw StateError('发送通道已结束');
    final message = Uint8List.fromList(utf8.encode(text));
    if (message.length > 1024 * 1024) throw const FormatException('通道消息过大');
    final envelope = <String, dynamic>{'accountId': _credentials['accountId'], 'hostId': _host['id'],
      'deviceId': _credentials['deviceId'], 'channelId': channelId, 'counter': _deviceCounter + 1,
      'kind': finalMessage ? 'channel.close' : 'channel.data'};
    try {
      _pushInput.add(SecretStreamPlainMessage(message, additionalData: relayAad(envelope),
        tag: finalMessage ? SecretStreamMessageTag.finalPush : SecretStreamMessageTag.message));
      if (!await _pushOutput.moveNext()) throw StateError('加密通道已关闭');
      _deviceCounter++;
      if (finalMessage) _pushFinished = true;
      return {...envelope, 'ciphertext': _encode(_pushOutput.current.message)};
    } catch (_) { _failed = true; rethrow; }
    finally { message.fillRange(0, message.length, 0); }
  });

  /// Returns the staged first request exactly once, after Host authentication.
  Future<Map<String, dynamic>> takeFirstEnvelope() => _serial(true, () async {
    if (_pullOutput == null) throw StateError('Host 尚未完成握手');
    final result = _firstEnvelope;
    if (result == null) throw StateError('第一条消息已取出');
    _firstEnvelope = null;
    return result;
  });

  Future<String> decrypt(Map<String, dynamic> envelope) => _serial(false, () async {
    final output = _pullOutput;
    final input = _pullInput;
    final isFinal = envelope['kind'] == 'channel.close';
    if (_pullFinished || output == null || input == null || !_matches(envelope) ||
        (envelope['kind'] != 'channel.data' && !isFinal) || envelope['counter'] != _hostCounter + 1) {
      _failed = true; throw const FormatException('通道消息顺序或身份无效');
    }
    try {
      input.add(SecretStreamCipherMessage(_decode(_string(envelope, 'ciphertext')), additionalData: relayAad(envelope)));
      if (!await output.moveNext() || output.current.tag != (isFinal ? SecretStreamMessageTag.finalPush : SecretStreamMessageTag.message)) {
        throw const FormatException('通道消息类型无效');
      }
      final message = output.current.message;
      try { final result = utf8.decode(message); _hostCounter++; if (isFinal) _pullFinished = true; return result; }
      finally { message.fillRange(0, message.length, 0); }
    } catch (_) { _failed = true; rethrow; }
  });

  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    // Operations already using stream state must finish before its key is freed.
    await Future.wait([_pushTail, _pullTail]);
    await _pushOutput.cancel();
    await _pullOutput?.cancel();
    unawaited(_pushInput.close());
    if (_pullInput != null) unawaited(_pullInput!.close());
    _pushKey.dispose(); _pullKey?.dispose();
  }
}
