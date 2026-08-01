package com.edfurman.nashbudget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import com.getcapacitor.annotation.CapacitorPlugin;
import org.junit.Test;

public class LocalBuildPolicyTest {
    @Test
    public void nativeShellUsesTheExpectedPackageAndCapacitorBridge() {
        assertEquals("com.edfurman.nashbudget", MainActivity.class.getPackageName());
        assertEquals(
            "BridgeActivity",
            MainActivity.class.getSuperclass().getSimpleName()
        );
        CapacitorPlugin exportPlugin = NativeFileExportPlugin.class.getAnnotation(
            CapacitorPlugin.class
        );
        assertNotNull(exportPlugin);
        assertEquals("NativeFileExport", exportPlugin.name());
    }
}
