package rocketbrain.ktlsp;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;
import java.util.jar.JarOutputStream;
import org.jetbrains.org.objectweb.asm.ClassReader;
import org.jetbrains.org.objectweb.asm.ClassVisitor;
import org.jetbrains.org.objectweb.asm.ClassWriter;
import org.jetbrains.org.objectweb.asm.MethodVisitor;
import org.jetbrains.org.objectweb.asm.Opcodes;

public final class KtlspWindowsPath {
    private KtlspWindowsPath() {}

    public static Path fromVirtualFile(String raw, String[] remaining) {
        // Kotlin's Windows virtual files can spell an absolute drive path as /C:\path.
        if (File.separatorChar == '\\' && raw.length() > 3 && raw.charAt(0) == '/' &&
                isDriveLetter(raw.charAt(1)) && raw.charAt(2) == ':' &&
                (raw.charAt(3) == '/' || raw.charAt(3) == '\\')) {
            raw = raw.substring(1);
        }
        return Paths.get(raw, remaining);
    }

    private static boolean isDriveLetter(char value) {
        return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z');
    }
}

final class PathFixTool {
    private static final String TARGET = "org/javacs/kt/SourcePath.class";
    private static final String ADAPTER = "rocketbrain/ktlsp/KtlspWindowsPath";
    private static final String PATH_SIGNATURE = "(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;";

    public static void main(String[] args) throws IOException {
        byte[] original;
        try (var input = new JarFile(args[0])) {
            var entry = input.getJarEntry(TARGET);
            if (entry == null || entry.getSize() > 1024 * 1024) throw new IOException("Unexpected ktlsp SourcePath entry.");
            try (var bytes = input.getInputStream(entry)) { original = bytes.readAllBytes(); }
        }
        var reader = new ClassReader(original);
        var writer = new ClassWriter(reader, 0);
        int[] replacements = {0};
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override
            public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                var method = super.visitMethod(access, name, descriptor, signature, exceptions);
                if (!name.equals("compileFiles") || !descriptor.equals("(Ljava/util/Collection;Z)Lorg/jetbrains/kotlin/resolve/BindingContext;")) return method;
                return new MethodVisitor(Opcodes.ASM9, method) {
                    @Override
                    public void visitMethodInsn(int opcode, String owner, String name, String type, boolean isInterface) {
                        if (opcode == Opcodes.INVOKESTATIC && owner.equals("java/nio/file/Paths") && name.equals("get") && type.equals(PATH_SIGNATURE)) {
                            super.visitMethodInsn(opcode, ADAPTER, "fromVirtualFile", type, false);
                            replacements[0]++;
                        } else {
                            super.visitMethodInsn(opcode, owner, name, type, isInterface);
                        }
                    }
                };
            }
        }, 0);
        if (replacements[0] != 1) throw new IOException("Expected exactly one ktlsp virtual-file path conversion.");
        try (var output = new JarOutputStream(Files.newOutputStream(Path.of(args[1])));
                var adapter = PathFixTool.class.getResourceAsStream("/" + ADAPTER + ".class")) {
            if (adapter == null) throw new IOException("Missing compiled Windows path adapter.");
            write(output, TARGET, writer.toByteArray());
            write(output, ADAPTER + ".class", adapter.readAllBytes());
        }
    }

    private static void write(JarOutputStream archive, String name, byte[] bytes) throws IOException {
        var entry = new JarEntry(name);
        entry.setTime(0);
        archive.putNextEntry(entry);
        archive.write(bytes);
        archive.closeEntry();
    }
}
