package com.microsoft.java.debug.core.adapter;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;

import com.google.gson.JsonElement;
import com.google.gson.JsonPrimitive;
import com.microsoft.java.debug.core.adapter.variables.StackFrameReference;
import com.microsoft.java.debug.core.protocol.Messages;
import com.sun.jdi.BooleanValue;
import com.sun.jdi.IntegerValue;
import com.sun.jdi.LocalVariable;
import com.sun.jdi.LongValue;
import com.sun.jdi.ObjectReference;
import com.sun.jdi.StackFrame;
import com.sun.jdi.StringReference;
import com.sun.jdi.Value;

/** Bounded Kotlin expressions over live JDI locals. No debuggee calls. */
final class KotlinWatchEvaluation {
    static final String REQUEST = "rocketbrain/evaluateKotlinWatch";
    private static final int MAX_EXPRESSION = 320;
    private static final int MAX_TEXT = 4096;
    private static final int MAX_NESTING = 24;
    private static final Map<IDebugAdapterContext, LinkedHashSet<Integer>> kotlinFrames = new WeakHashMap<>();

    private enum Kind {
        INT("kotlin.Int"), LONG("kotlin.Long"), BOOLEAN("kotlin.Boolean"), STRING("kotlin.String"),
        NULL("kotlin.Nothing?"), INDEXED("");
        final String type;
        Kind(String type) { this.type = type; }
    }

    private static final class Scalar {
        final Kind kind;
        final Object value;
        Scalar(Kind kind, Object value) { this.kind = kind; this.value = value; }
        String display() {
            if (kind == Kind.INDEXED) throw invalid("Read a supported collection with .size or an Int index.");
            return kind == Kind.STRING ? new JsonPrimitive((String) value).toString() : String.valueOf(value);
        }
        long numeric() {
            if (kind == Kind.INT || kind == Kind.LONG) return ((Number) value).longValue();
            throw invalid("Use an observed Kotlin Int or Long for this operator.");
        }
        boolean truth() {
            if (kind != Kind.BOOLEAN) throw invalid("Use an observed Kotlin Boolean for this operator.");
            return (Boolean) value;
        }
    }

    private interface Expression { Scalar evaluate(StackFrame frame) throws Exception; }
    private interface Operand { Expression parse(); }

    private KotlinWatchEvaluation() { }

    static CompletableFuture<Messages.Response> dispatch(Messages.Request request, Messages.Response response, IDebugAdapterContext context) {
        boolean explicit = REQUEST.equals(request.command);
        if (!explicit && !"evaluate".equals(request.command)) return null;
        Integer frameId = frameId(request);
        boolean kotlin = explicit || known(context, frameId);
        if (frameId == null) return kotlin ? stale(response) : null;
        try {
            if (context.isVmTerminated() || context.getLaunchMode() != LaunchMode.DEBUG) return kotlin ? stale(response) : null;
            Object pooled = context.getRecyclableIdPool().getObjectById(frameId);
            if (!(pooled instanceof StackFrameReference)) return kotlin ? stale(response) : null;
            StackFrameReference reference = (StackFrameReference) pooled;
            if (!reference.getThread().isSuspended()) return kotlin ? stale(response) : null;
            StackFrame frame = context.getStackFrameManager().getStackFrame(reference);
            if (frame == null) return kotlin ? stale(response) : null;
            String source = frame.location().sourceName();
            if (!source.endsWith(".kt") && !source.endsWith(".kts")) {
                return kotlin ? error(response, "Choose a paused Kotlin source frame in this debug session.") : null;
            }
            kotlin = true;
            remember(context, frameId);
            JsonElement node = request.arguments.get("expression");
            String text = node != null && node.isJsonPrimitive() && node.getAsJsonPrimitive().isString() ? node.getAsString() : "";
            if (text.isBlank() || text.length() > MAX_EXPRESSION || text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
                throw invalid("Enter one Kotlin watch expression of up to 320 characters.");
            }
            Scalar value = new Parser(text).parse().evaluate(frame);
            // Recheck the suspended JDI frame even for a constant expression.
            if (!reference.getThread().isSuspended() || context.getRecyclableIdPool().getObjectById(frameId) != reference) {
                return stale(response);
            }
            frame.location();
            response.body = Map.of("result", value.display(), "type", value.kind.type, "variablesReference", 0);
            return CompletableFuture.completedFuture(response);
        } catch (IllegalArgumentException unsupported) {
            return kotlin ? error(response, unsupported.getMessage()) : null;
        } catch (Exception unavailable) {
            return kotlin ? stale(response) : null;
        }
    }

    private static Integer frameId(Messages.Request request) {
        try {
            JsonElement id = request.arguments == null ? null : request.arguments.get("frameId");
            if (id == null || !id.isJsonPrimitive() || !id.getAsJsonPrimitive().isNumber()) return null;
            int parsed = id.getAsBigDecimal().intValueExact();
            return parsed < 1 ? null : parsed;
        } catch (RuntimeException invalid) { return null; }
    }

    private static synchronized boolean known(IDebugAdapterContext context, Integer frameId) {
        var frames = kotlinFrames.get(context);
        return frames != null && frames.contains(frameId);
    }

    private static synchronized void remember(IDebugAdapterContext context, int frameId) {
        var frames = kotlinFrames.computeIfAbsent(context, ignored -> new LinkedHashSet<>());
        frames.add(frameId);
        if (frames.size() > 256) frames.remove(frames.iterator().next());
    }

    private static CompletableFuture<Messages.Response> stale(Messages.Response response) {
        return error(response, "The Kotlin watch requires a current suspended frame from this debug session.");
    }

    private static CompletableFuture<Messages.Response> error(Messages.Response response, String text) {
        return AdapterUtils.createAsyncErrorResponse(response, ErrorCode.EVALUATE_FAILURE, text);
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
    private static IllegalArgumentException syntax() {
        return invalid("Use a Kotlin watch expression with supported scalars or indexed locals. Calls, assignments, arbitrary properties and interpolation are unsupported.");
    }

    private static Scalar observe(StackFrame frame, String name) throws Exception {
        LocalVariable local;
        try { local = frame.visibleVariableByName(name); }
        catch (com.sun.jdi.AbsentInformationException unavailable) {
            throw invalid("The paused Kotlin frame has no visible local variable metadata.");
        }
        if (local == null) throw invalid("No visible Kotlin local named " + name + " at this paused frame.");
        return fromJdi(frame.getValue(local));
    }

    private static Scalar fromJdi(Value value) {
        if (value instanceof ObjectReference && !(value instanceof StringReference)) {
            var indexed = LocalValueInspection.indexed(value);
            if (indexed != null) return new Scalar(Kind.INDEXED, indexed);
            ObjectReference object = (ObjectReference) value;
            String type = object.referenceType().name();
            String signature = Map.of("java.lang.Integer", "I", "java.lang.Long", "J", "java.lang.Boolean", "Z").get(type);
            if (signature == null || object.referenceType().classLoader() != null) throw invalid("Use a supported Kotlin scalar, array or standard JVM list layout.");
            var field = object.referenceType().fieldByName("value");
            if (field == null || field.isStatic() || !signature.equals(field.signature())) throw invalid("The Kotlin boxed scalar layout is unavailable.");
            value = object.getValue(field);
        }
        if (value == null) return new Scalar(Kind.NULL, null);
        if (value instanceof IntegerValue) return new Scalar(Kind.INT, ((IntegerValue) value).value());
        if (value instanceof LongValue) return new Scalar(Kind.LONG, ((LongValue) value).value());
        if (value instanceof BooleanValue) return new Scalar(Kind.BOOLEAN, ((BooleanValue) value).value());
        if (value instanceof StringReference) {
            var string = (StringReference) value;
            if (LocalValueInspection.storageUnits(string) > MAX_TEXT) throw invalid("The Kotlin string exceeds 4096 UTF-16 units.");
            return new Scalar(Kind.STRING, string.value());
        }
        throw invalid("Use a supported Kotlin scalar, array or standard JVM list layout.");
    }

    private static Scalar indexedElement(Scalar receiver, Scalar index) {
        if (receiver.kind != Kind.INDEXED || index.kind != Kind.INT) throw invalid("Use an Int index on a supported Kotlin array or list.");
        var values = (LocalValueInspection.IndexedValue) receiver.value;
        int at = (Integer) index.value;
        if (at < 0 || at >= values.length) throw invalid("The Kotlin collection index is out of range.");
        return fromJdi(values.value(at));
    }

    private static Scalar property(Scalar receiver, String name, boolean safe) {
        if (receiver.kind == Kind.NULL && safe) return receiver;
        if (receiver.kind == Kind.STRING && name.equals("length")) return new Scalar(Kind.INT, ((String) receiver.value).length());
        if (receiver.kind == Kind.INDEXED && name.equals("size")) {
            return new Scalar(Kind.INT, ((LocalValueInspection.IndexedValue) receiver.value).length);
        }
        throw invalid("Use String.length or .size on a supported Kotlin array or list.");
    }

    private static Scalar binary(String operator, Scalar left, Scalar right) {
        if (operator.equals("==") || operator.equals("!=")) {
            if (left.kind != Kind.NULL && right.kind != Kind.NULL && (left.kind != right.kind || left.kind == Kind.INDEXED)) {
                throw invalid("Compare Kotlin scalars of the same observed type.");
            }
            boolean equal = java.util.Objects.equals(left.value, right.value);
            return new Scalar(Kind.BOOLEAN, operator.equals("==") ? equal : !equal);
        }
        if (operator.equals("+") && left.kind == Kind.STRING && right.kind != Kind.INDEXED) {
            String text = (String) left.value + String.valueOf(right.value);
            if (text.length() > MAX_TEXT) throw invalid("The Kotlin string exceeds 4096 UTF-16 units.");
            return new Scalar(Kind.STRING, text);
        }
        long a = left.numeric(), b = right.numeric();
        switch (operator) {
            case "<": return new Scalar(Kind.BOOLEAN, a < b);
            case ">": return new Scalar(Kind.BOOLEAN, a > b);
            case "<=": return new Scalar(Kind.BOOLEAN, a <= b);
            case ">=": return new Scalar(Kind.BOOLEAN, a >= b);
            default: break;
        }
        if (b == 0 && (operator.equals("/") || operator.equals("%"))) throw invalid("Kotlin integer division by zero.");
        long result;
        switch (operator) {
            case "+": result = a + b; break;
            case "-": result = a - b; break;
            case "*": result = a * b; break;
            case "/": result = a / b; break;
            case "%": result = a % b; break;
            default: throw syntax();
        }
        return left.kind == Kind.LONG || right.kind == Kind.LONG ? new Scalar(Kind.LONG, result) : new Scalar(Kind.INT, (int) result);
    }

    private static final class Parser {
        private final String source;
        private int offset, nesting;

        Parser(String source) { this.source = source; }

        Expression parse() {
            Expression root = or();
            space();
            if (offset != source.length()) throw syntax();
            return root;
        }

        private Expression or() { return group(this::and, "||"); }
        private Expression and() { return group(this::equality, "&&"); }
        private Expression equality() { return group(this::comparison, "==", "!="); }
        private Expression comparison() { return group(this::elvis, ">=", "<=", ">", "<"); }
        private Expression elvis() { return group(this::additive, "?:"); }
        private Expression additive() { return group(this::multiplicative, "+", "-"); }
        private Expression multiplicative() { return group(this::unary, "*", "/", "%"); }

        private Expression group(Operand next, String... operators) {
            Expression left = next.parse();
            for (String op = operator(operators); op != null; op = operator(operators)) {
                Expression first = left, second = next.parse();
                String token = op;
                left = frame -> {
                    Scalar value = first.evaluate(frame);
                    switch (token) {
                        case "||": return new Scalar(Kind.BOOLEAN, value.truth() || second.evaluate(frame).truth());
                        case "&&": return new Scalar(Kind.BOOLEAN, value.truth() && second.evaluate(frame).truth());
                        case "?:": return value.kind == Kind.NULL ? second.evaluate(frame) : value;
                        default: return binary(token, value, second.evaluate(frame));
                    }
                };
            }
            return left;
        }

        private Expression nested(Operand next) {
            if (++nesting > MAX_NESTING) throw invalid("The Kotlin watch expression is nested too deeply.");
            try { return next.parse(); } finally { nesting--; }
        }

        private Expression unary() {
            String op = operator("!", "-", "+");
            if (op == null) return postfix();
            Expression operand = nested(this::unary);
            return frame -> {
                Scalar value = operand.evaluate(frame);
                if (op.equals("!")) return new Scalar(Kind.BOOLEAN, !value.truth());
                long number = value.numeric();
                if (op.equals("+")) return value;
                return value.kind == Kind.INT ? new Scalar(Kind.INT, -(int) number) : new Scalar(Kind.LONG, -number);
            };
        }

        private Expression postfix() {
            Expression result = primary();
            for (;;) {
                Expression receiver = result;
                if (operator("[") != null) {
                    Expression index = nested(this::or);
                    if (operator("]") == null) throw syntax();
                    result = frame -> indexedElement(receiver.evaluate(frame), index.evaluate(frame));
                } else {
                    String access = operator("?.", ".");
                    if (access == null) return result;
                    String name = identifier();
                    if (!"length".equals(name) && !"size".equals(name)) throw syntax();
                    result = frame -> property(receiver.evaluate(frame), name, access.equals("?."));
                }
            }
        }

        private Expression primary() {
            space();
            if (operator("(") != null) {
                Expression group = nested(this::or);
                if (operator(")") == null) throw syntax();
                return group;
            }
            if (offset >= source.length()) throw syntax();
            char current = source.charAt(offset);
            if (current == '"') return literal(new Scalar(Kind.STRING, string()));
            if (current >= '0' && current <= '9') {
                int start = offset++;
                while (offset < source.length() && source.charAt(offset) >= '0' && source.charAt(offset) <= '9') offset++;
                String digits = source.substring(start, offset);
                if (digits.length() > 1 && digits.startsWith("0")) throw syntax();
                boolean isLong = offset < source.length() && source.charAt(offset) == 'L';
                if (isLong) offset++;
                try {
                    return literal(isLong ? new Scalar(Kind.LONG, Long.valueOf(digits)) : new Scalar(Kind.INT, Integer.valueOf(digits)));
                } catch (NumberFormatException invalid) {
                    throw invalid("The Kotlin watch supports decimal Int literals and decimal Long literals with an L suffix.");
                }
            }
            String name = identifier();
            if (name == null) throw syntax();
            if (name.equals("null")) return literal(new Scalar(Kind.NULL, null));
            if (name.equals("true") || name.equals("false")) return literal(new Scalar(Kind.BOOLEAN, Boolean.valueOf(name)));
            return frame -> observe(frame, name);
        }

        private String string() {
            offset++;
            StringBuilder value = new StringBuilder();
            while (offset < source.length()) {
                char character = source.charAt(offset++);
                if (character == '"') return value.toString();
                if (character == '$' || character < 32) throw syntax();
                if (character == '\\') {
                    if (offset >= source.length()) throw syntax();
                    switch (source.charAt(offset++)) {
                        case 't': character = '\t'; break;
                        case 'b': character = '\b'; break;
                        case 'n': character = '\n'; break;
                        case 'r': character = '\r'; break;
                        case '\\': character = '\\'; break;
                        case '"': character = '"'; break;
                        case '$': character = '$'; break;
                        default: throw syntax();
                    }
                }
                value.append(character);
            }
            throw syntax();
        }

        private String identifier() {
            space();
            if (offset >= source.length() || !identifierStart(source.charAt(offset))) return null;
            int start = offset++;
            while (offset < source.length()) {
                char current = source.charAt(offset);
                if (!identifierStart(current) && (current < '0' || current > '9')) break;
                offset++;
            }
            return source.substring(start, offset);
        }

        private static boolean identifierStart(char current) {
            return current == '_' || current >= 'a' && current <= 'z' || current >= 'A' && current <= 'Z';
        }

        private String operator(String... possibilities) {
            space();
            for (String candidate : possibilities) if (source.startsWith(candidate, offset)) {
                if ((candidate.equals("+") || candidate.equals("-") || candidate.equals("!")) &&
                    offset + 1 < source.length() && source.charAt(offset + 1) == candidate.charAt(0)) throw syntax();
                offset += candidate.length();
                return candidate;
            }
            return null;
        }

        private void space() {
            while (offset < source.length() && (source.charAt(offset) == ' ' || source.charAt(offset) == '\t')) offset++;
        }

        private static Expression literal(Scalar scalar) { return ignored -> scalar; }
    }
}
