package com.microsoft.java.debug.core.adapter;

import com.sun.jdi.Field;
import com.sun.jdi.Method;
import com.sun.jdi.ReferenceType;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.List;

/** Proves Kotlin's default JVM accessors against the exact backing field they address. */
final class KotlinFieldAccess {
    private static final int MAX_POOL_BYTES = 1024 * 1024;
    private static final int MAX_POOL_ENTRIES = 8192;
    private final String owner;
    private final String[] strings;
    private final int[][] entries;

    private KotlinFieldAccess(ReferenceType type) throws IOException {
        owner = type.name().replace('.', '/');
        int count = type.constantPoolCount();
        if (count < 1 || count > MAX_POOL_ENTRIES) throw new IOException("Constant pool outside inspection bound.");
        byte[] bytes = type.constantPool();
        if (bytes == null || bytes.length > MAX_POOL_BYTES) throw new IOException("Constant pool outside inspection bound.");
        strings = new String[count];
        entries = new int[count][];
        try (var stream = new DataInputStream(new ByteArrayInputStream(bytes))) {
            for (int i = 1; i < count; i++) {
                int tag = stream.readUnsignedByte();
                switch (tag) {
                    case 1: strings[i] = stream.readUTF(); break;
                    case 3: case 4: skip(stream,4); break;
                    case 5: case 6: skip(stream,8); i++; break;
                    case 7: case 8: entries[i] = new int[] {tag, stream.readUnsignedShort()}; break;
                    case 16: case 19: case 20: skip(stream,2); break;
                    case 9: case 10: case 12: entries[i] = new int[] {tag, stream.readUnsignedShort(), stream.readUnsignedShort()}; break;
                    case 11: case 17: case 18: skip(stream,4); break;
                    case 15: skip(stream,3); break;
                    default: throw new IOException("Unsupported constant pool entry.");
                }
            }
            if (stream.read() != -1) throw new IOException("Trailing constant pool bytes.");
        }
    }

    private static void skip(DataInputStream stream, int width) throws IOException {
        if (stream.skipBytes(width) != width) throw new IOException("Truncated constant pool entry.");
    }

    static KotlinFieldAccess inspect(ReferenceType type) {
        if (!type.virtualMachine().canGetBytecodes() || !type.virtualMachine().canGetConstantPool()) return null;
        try { return new KotlinFieldAccess(type); }
        catch (IOException unavailable) { return null; }
    }

    static boolean writable(Field field, KotlinFieldAccess access) {
        if (field.isFinal() || field.isStatic()) return false;
        if (field.isPublic()) return true; // Direct JVM field, independent of any property accessors.
        if (!directGetter(field, access)) return false;
        ReferenceType type = field.declaringType();
        String signature = field.signature();
        Method setter = method(type, "set" + title(field.name()), "(" + signature + ")V");
        if (setter == null) return false;
        byte[] write = setter.bytecodes();
        int address = write.length == 6 ? 0 : access.nonNullStringPrefix(field, write);
        if (address < 0) return false;
        int loadOp = signature.equals("J") ? 0x1f : signature.startsWith("L") ? 0x2b : 0x1b;
        return op(write,address) == 0x2a && op(write,address+1) == loadOp && op(write,address+2) == 0xb5
            && op(write,address+5) == 0xb1 && access.fieldMatches(index(write,address+3), field);
    }

    static boolean directGetter(Field field, KotlinFieldAccess access) {
        if (field.isPublic()) return true;
        if (access == null) return false;
        String name = field.name(), signature = field.signature();
        Method getter = method(field.declaringType(), isStyle(name) ? name : "get" + title(name), "()" + signature);
        if (getter == null) return false;
        byte[] read = getter.bytecodes();
        int returnOp = signature.equals("J") ? 0xad : signature.startsWith("L") || signature.startsWith("[") ? 0xb0 : 0xac;
        return read.length == 5 && op(read,0) == 0x2a && op(read,1) == 0xb4 && op(read,4) == returnOp
            && access.fieldMatches(index(read,2), field);
    }

    private int nonNullStringPrefix(Field field, byte[] write) {
        if (!KotlinFieldValues.isString(field) || (write.length != 12 && write.length != 13) || op(write,0) != 0x2b) return -1;
        int invoke = write.length - 9;
        int argument = invoke == 3 && op(write,1) == 0x12 ? op(write,2)
            : invoke == 4 && op(write,1) == 0x13 ? index(write,2) : -1;
        int[] constant = entry(argument,8);
        int[] method = entry(index(write,invoke+1),10);
        if (constant == null || !"<set-?>".equals(string(constant[1])) || op(write,invoke) != 0xb8 || method == null) return -1;
        int[] type = entry(method[1],7), name = entry(method[2],12);
        return type != null && name != null && "kotlin/jvm/internal/Intrinsics".equals(string(type[1]))
            && "checkNotNullParameter".equals(string(name[1])) && "(Ljava/lang/Object;Ljava/lang/String;)V".equals(string(name[2]))
            ? invoke+3 : -1;
    }

    private static boolean isStyle(String name) { return name.length() > 2 && name.startsWith("is") && Character.isUpperCase(name.charAt(2)); }
    private static String title(String name) { return isStyle(name) ? name.substring(2) : Character.toUpperCase(name.charAt(0)) + name.substring(1); }

    private static Method method(ReferenceType type, String name, String signature) {
        List<Method> matches = type.methodsByName(name, signature);
        if (matches.size() != 1) return null;
        Method method = matches.get(0);
        return type.equals(method.declaringType()) && !method.isStatic() && !method.isObsolete() ? method : null;
    }

    private boolean fieldMatches(int index, Field field) {
        int[] ref = entry(index,9);
        if (ref == null) return false;
        int[] type = entry(ref[1],7), name = entry(ref[2],12);
        return type != null && name != null && owner.equals(string(type[1]))
            && field.name().equals(string(name[1])) && field.signature().equals(string(name[2]));
    }

    private int[] entry(int index, int tag) {
        int[] entry = index > 0 && index < entries.length ? entries[index] : null;
        return entry != null && entry[0] == tag ? entry : null;
    }

    private String string(int index) { return index > 0 && index < strings.length ? strings[index] : null; }
    private static int op(byte[] code, int at) { return code[at] & 255; }
    private static int index(byte[] code, int at) { return (op(code,at) << 8) | op(code,at+1); }
}
