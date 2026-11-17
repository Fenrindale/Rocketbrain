package dev.rocketbrain;

import java.util.List;
import java.util.Set;

/** Owned fixture for semantic edits and executable before/after comparisons. */
public class RefactorFixture {
    public static int calculation(int value) {
        return value * 2 + 3;
    }

    public static int inlineLocal(int value) {
        int doubled = value * 2;
        return doubled + 3;
    }

    public static String join(List<String> values) {
        return String.join(",", values);
    }

    public static void main(String[] args) {
        System.out.println(calculation(4) + ":" + inlineLocal(4) + ":" + join(List.of("A", "B")));
    }
}
