import 'dart:async';
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override State<ScanScreen> createState() => _ScanScreenState();
}
class _ScanScreenState extends State<ScanScreen> with WidgetsBindingObserver {
  final controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool returned = false;
  @override void initState() { super.initState(); WidgetsBinding.instance.addObserver(this); }
  @override void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !returned) { unawaited(controller.start()); }
    else if (state == AppLifecycleState.inactive) { unawaited(controller.stop()); }
  }
  @override void dispose() { WidgetsBinding.instance.removeObserver(this); unawaited(controller.dispose()); super.dispose(); }
  @override Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('扫描电脑配对码')),
    body: MobileScanner(controller: controller, onDetect: (capture) {
      if (returned) return;
      final value = capture.barcodes.map((barcode) => barcode.rawValue).whereType<String>().firstOrNull;
      if (value == null || value.length > 8192) return;
      returned = true; unawaited(controller.stop()); Navigator.pop(context, value);
    }));
}
