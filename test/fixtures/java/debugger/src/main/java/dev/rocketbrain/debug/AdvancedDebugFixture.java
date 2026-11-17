package dev.rocketbrain.debug;

public class AdvancedDebugFixture {
    private static int sink;

    static class Box {
        int value = 3;
        String text = "before";
    }

    public static void main(String[] args) {
        String mode = args.length == 0 ? "advanced" : args[0];
        if (mode.equals("caught")) {
            try {
                throwCaught();
            } catch (IllegalStateException expected) {
                System.out.println(expected.getMessage());
            }
            return;
        }
        if (mode.equals("uncaught")) {
            throw new IllegalArgumentException("uncaught-fixture");
        }
        Box box = new Box();
        int mutable = 2;
        String text = "before";
        for (int i = 1; i <= 5; i++) {
            sink += i; // CONDITION
        }
        for (int hit = 1; hit <= 4; hit++) {
            sink += hit; // HIT_COUNT
        }
        for (int log = 1; log <= 3; log++) {
            sink += log; // LOG_POINT
        }
        int afterLogs = sink; // MUTATION_GATE
        int nested = helper(mutable); // STEP_IN
        HcrTarget target = new HcrTarget();
        int before = target.value();
        int hcrGate = before; // HCR_GATE
        int after = target.value();
        int complete = after; // HCR_AFTER
        System.out.println(afterLogs + nested + hcrGate + complete + box.value + text.length());
    }

    private static int helper(int input) {
        int doubled = input * 2;
        return doubled;
    }

    private static void throwCaught() {
        throw new IllegalStateException("caught-fixture");
    }
}
