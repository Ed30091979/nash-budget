package ru.familybudget.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class LocalBuildPolicyTest {
    @Test
    public void nativeShellUsesTheExpectedPackageAndCapacitorBridge() {
        assertEquals("ru.familybudget.app", MainActivity.class.getPackageName());
        assertEquals(
            "BridgeActivity",
            MainActivity.class.getSuperclass().getSimpleName()
        );
    }
}
