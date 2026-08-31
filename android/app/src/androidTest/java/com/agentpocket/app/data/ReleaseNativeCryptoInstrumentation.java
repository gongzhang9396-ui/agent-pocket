package com.agentpocket.app.data;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import android.util.Log;
import com.goterl.lazysodium.LazySodiumAndroid;
import com.goterl.lazysodium.SodiumAndroid;
import com.sun.jna.Pointer;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;

public final class ReleaseNativeCryptoInstrumentation extends Instrumentation {
    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override
    public void onStart() {
        Bundle results = new Bundle();
        try {
            Field peer = Pointer.class.getDeclaredField("peer");
            if (peer.getType() != long.class) {
                throw new AssertionError("JNA Pointer.peer has an unexpected type");
            }

            LazySodiumAndroid sodium = new LazySodiumAndroid(new SodiumAndroid(), StandardCharsets.UTF_8);
            byte[] boxPublicKey = new byte[32];
            byte[] boxPrivateKey = new byte[32];
            byte[] signPublicKey = new byte[32];
            byte[] signPrivateKey = new byte[64];
            if (!sodium.cryptoBoxKeypair(boxPublicKey, boxPrivateKey)) {
                throw new AssertionError("X25519 keypair generation failed");
            }
            if (!sodium.cryptoSignKeypair(signPublicKey, signPrivateKey)) {
                throw new AssertionError("Ed25519 keypair generation failed");
            }
            if (allZero(boxPublicKey) || allZero(boxPrivateKey) || allZero(signPublicKey) || allZero(signPrivateKey)) {
                throw new AssertionError("Native keypair generation returned zero material");
            }
            ReleaseCryptoVectorVerifier.verify(getContext(), sodium);

            results.putString("stream", "JNA native checks and all relay crypto vectors passed");
            finish(Activity.RESULT_OK, results);
        } catch (Throwable error) {
            results.putString("stream", Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, results);
        }
    }

    private static boolean allZero(byte[] value) {
        int combined = 0;
        for (byte item : value) combined |= item;
        return combined == 0;
    }
}
