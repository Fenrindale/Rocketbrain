import java.io.PrintStream;
import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.reflect.AccessFlag;
import java.lang.module.ModuleDescriptor;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.jar.JarFile;
import java.util.zip.ZipFile;

/** Reads trusted component bytecode metadata without loading application classes. */
public final class FxmlClassInspector {
    private static final int CLASS_LIMIT = 6000;
    private static final int MAX_CLASS_BYTES = 512 * 1024;
    private static final ClassFile READER = ClassFile.of();
    private static int classes;
    private static int bytes;

    public static void main(String[] arguments) throws Exception {
        System.setOut(new PrintStream(System.out, false, StandardCharsets.UTF_8));
        var input = Files.readAllLines(Path.of(arguments[0]), StandardCharsets.UTF_8);
        if (input.size() > 512) throw new IllegalArgumentException("FXML class inspection input limit.");
        for (int index = 0; index < input.size(); index++) {
            String line = input.get(index);
            String[] fields = line.split("\t", 3);
            if (fields.length != 3) throw new IllegalArgumentException("Invalid FXML class input.");
            Path file = Path.of(new String(Base64.getDecoder().decode(fields[1]), StandardCharsets.UTF_8));
            switch (fields[0]) {
                case "jar" -> readOpenJfx(file, index, fields[2]);
                case "class" -> {
                    if (Files.size(file) > MAX_CLASS_BYTES) throw new IllegalArgumentException("Oversize FXML class.");
                    inspect(index, fields[2], Files.readAllBytes(file), true);
                }
                default -> throw new IllegalArgumentException("Unknown FXML class input.");
            }
        }
    }

    private static void readOpenJfx(Path file, int index, String expectedModule) throws Exception {
        try (var jar = new JarFile(file.toFile(), true, ZipFile.OPEN_READ, Runtime.version())) {
            if (jar.size() > 9500) throw new IllegalArgumentException("FXML module entry limit.");
            var descriptor = jar.getJarEntry("module-info.class");
            if (descriptor == null) return; // OpenJFX's placeholder artifact has no platform classes.
            Set<String> exports = new HashSet<>();
            try (var stream = jar.getInputStream(descriptor)) {
                var module = ModuleDescriptor.read(stream);
                if (!module.name().equals(expectedModule)) throw new IllegalArgumentException("Unexpected OpenJFX module.");
                for (var entry : module.exports()) if (!entry.isQualified()) exports.add(entry.source());
            }
            var entries = jar.versionedStream().iterator();
            while (entries.hasNext()) {
                var entry = entries.next();
                String name = entry.getName();
                if (!name.matches("javafx/(?:[a-zA-Z_][a-zA-Z_0-9]*/)*[a-zA-Z_][a-zA-Z_0-9]*\\.class")) continue;
                name = name.substring(0, name.length() - 6);
                try (var stream = jar.getInputStream(entry)) {
                    inspect(index, name, stream.readNBytes(MAX_CLASS_BYTES + 1),
                        exports.contains(name.substring(0, name.lastIndexOf('/')).replace('/', '.')));
                }
            }
        }
    }

    private static void inspect(int index, String name, byte[] data, boolean accessible) {
        if (++classes > CLASS_LIMIT || data.length > MAX_CLASS_BYTES || (bytes += data.length) > 64 * 1024 * 1024) {
            throw new IllegalArgumentException("FXML class inspection limit.");
        }
        var model = READER.parse(data);
        if (!model.thisClass().asInternalName().equals(name)) throw new IllegalArgumentException("FXML class path mismatch.");
        boolean visible = accessible && model.flags().has(AccessFlag.PUBLIC);
        boolean constructor = visible && !model.flags().has(AccessFlag.ABSTRACT) && model.methods().stream().anyMatch(method ->
            method.methodName().equalsString("<init>") && method.methodType().equalsString("()V") &&
            method.flags().has(AccessFlag.PUBLIC));
        String parent = model.superclass().map(entry -> entry.asInternalName()).orElse("");
        String source = model.findAttribute(Attributes.sourceFile())
            .map(attribute -> attribute.sourceFile().stringValue()).filter(value -> value.matches("[a-zA-Z_][a-zA-Z_0-9]*\\.java")).orElse("");
        System.out.printf(Locale.ROOT, "class\t%d\t%s\t%s\t%s\t%s\t%s%n", index, name, parent, visible, constructor, source);
        if (!visible) return;
        for (var method : model.methods()) {
            var flags = method.flags();
            if (!flags.has(AccessFlag.PUBLIC) || flags.has(AccessFlag.STATIC) || flags.has(AccessFlag.SYNTHETIC)) continue;
            String nameOfMethod = method.methodName().stringValue();
            if (!nameOfMethod.matches("(?:set|get|is)[A-Z][a-zA-Z_0-9]{0,100}") ||
                nameOfMethod.matches("(?:set|get|is)On[A-Z].*")) continue;
            var type = method.methodTypeSymbol();
            String valueType;
            if (nameOfMethod.startsWith("set")) {
                if (type.parameterCount() != 1 || !type.returnType().descriptorString().equals("V")) continue;
                valueType = type.parameterType(0).descriptorString();
            } else {
                if (type.parameterCount() != 0) continue;
                valueType = type.returnType().descriptorString();
            }
            if (valueType.matches("[ZBCSIJFD]|L[a-zA-Z_0-9/$]+;")) {
                System.out.printf(Locale.ROOT, "member\t%s\t%s\t%s%n", name, nameOfMethod, valueType);
            }
        }
    }
}
