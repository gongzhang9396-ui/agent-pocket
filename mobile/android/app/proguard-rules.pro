# ML Kit discovers these components from AndroidManifest metadata and creates
# them through their public no-argument constructors. Keep only those entry
# points; mobile_scanner 7.2.0's single-level com.google.mlkit.* rule misses them.
# https://developer.android.com/topic/performance/app-optimization/keep-rule-examples
-keep class com.google.mlkit.common.internal.CommonComponentRegistrar {
    public <init>();
}
-keep class com.google.mlkit.vision.barcode.internal.BarcodeRegistrar {
    public <init>();
}
-keep class com.google.mlkit.vision.common.internal.VisionCommonRegistrar {
    public <init>();
}
