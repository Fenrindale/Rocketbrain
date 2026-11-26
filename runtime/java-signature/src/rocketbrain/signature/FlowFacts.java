package rocketbrain.signature;

import java.util.Objects;
import javax.lang.model.type.TypeMirror;
import com.sun.source.tree.Tree;

/** Small abstract-value domain for attributed integral, boolean and String flows. */
final class FlowFacts {
    enum Special { UNKNOWN, NULL, STRING }
    static final Object UNKNOWN = Special.UNKNOWN;
    static final Object NULL = Special.NULL;
    static final Object STRING = Special.STRING;

    private FlowFacts() {}

    static Object literal(Object value) {
        if (value == null) return NULL;
        if (value instanceof String) return STRING;
        if (value instanceof Boolean) return value;
        if (value instanceof Character character) return (long)character.charValue();
        if (value instanceof Integer || value instanceof Long) return ((Number)value).longValue();
        return UNKNOWN;
    }

    static Object stored(TypeMirror type, Object value) {
        return switch (type.getKind()) {
            case BOOLEAN -> value instanceof Boolean ? value : UNKNOWN;
            case BYTE, CHAR, SHORT, INT, LONG -> value instanceof Long ? value : UNKNOWN;
            case DECLARED -> type.toString().equals("java.lang.String") && (value == NULL || value == STRING) ? value : UNKNOWN;
            default -> UNKNOWN;
        };
    }

    static Object cast(TypeMirror type, Object value) {
        // Numeric casts can round, sign-extend or narrow. Leave their facts open.
        return switch (type.getKind()) {
            case BOOLEAN, DECLARED -> stored(type,value);
            default -> UNKNOWN;
        };
    }

    static Object common(Object first, Object second) {
        return Objects.equals(first,second) ? first : UNKNOWN;
    }

    static Object negated(Object value) {
        return value instanceof Boolean flag ? !flag : UNKNOWN;
    }

    private static Object equal(Object first, Object second) {
        if (first == UNKNOWN || second == UNKNOWN) return UNKNOWN;
        if (first == NULL || second == NULL) return first == second;
        if (first instanceof Boolean && second instanceof Boolean || first instanceof Long && second instanceof Long) {
            return first.equals(second);
        }
        return UNKNOWN; // Non-null strings do not imply the same object identity.
    }

    static Object binary(Tree.Kind kind, Object first, Object second) {
        if (kind == Tree.Kind.EQUAL_TO || kind == Tree.Kind.NOT_EQUAL_TO) {
            Object result = equal(first,second);
            return kind == Tree.Kind.EQUAL_TO ? result : negated(result);
        }
        if (first instanceof Long left && second instanceof Long right) {
            return switch (kind) {
                case LESS_THAN -> left < right;
                case LESS_THAN_EQUAL -> left <= right;
                case GREATER_THAN -> left > right;
                case GREATER_THAN_EQUAL -> left >= right;
                default -> UNKNOWN;
            };
        }
        if (kind == Tree.Kind.CONDITIONAL_AND || kind == Tree.Kind.CONDITIONAL_OR) {
            boolean decisive = kind == Tree.Kind.CONDITIONAL_OR;
            if (Boolean.valueOf(decisive).equals(first) || Boolean.valueOf(decisive).equals(second)) return decisive;
            if (first instanceof Boolean && second instanceof Boolean) return !decisive;
        }
        return UNKNOWN;
    }
}
