import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.instruction.InvokeInstruction;
import java.lang.classfile.instruction.LineNumber;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/** Reads class-file metadata without loading workspace classes. */
public final class MixedClassInspector {
    public static void main(String... arguments) throws Exception {
        System.setOut(new PrintStream(System.out, false, StandardCharsets.UTF_8));
        var files = Files.readAllLines(Path.of(arguments[0]), StandardCharsets.UTF_8);
        if (files.isEmpty() || files.size() > 500) throw new IllegalArgumentException("Class-file input limit.");
        int totalMethods = 0;
        int totalCalls = 0;
        for (int index = 0; index < files.size(); index++) {
            Path file = Path.of(new String(Base64.getDecoder().decode(files.get(index)), StandardCharsets.UTF_8));
            var model = ClassFile.of().parse(file);
            var name = model.thisClass().asInternalName();
            var source = model.findAttribute(Attributes.sourceFile()).map(attribute -> attribute.sourceFile().stringValue()).orElse("");
            var parent = model.superclass().map(entry -> entry.asInternalName()).orElse("");
            row("class", index, name, source, parent);
            for (var method : model.methods()) {
                var code = method.code();
                if (code.isEmpty()) continue;
                if (++totalMethods > 8000) throw new IllegalArgumentException("Mixed JVM method limit.");
                String methodName = method.methodName().stringValue();
                String descriptor = method.methodType().stringValue();
                int first = Integer.MAX_VALUE;
                int line = 0;
                var calls = new ArrayList<List<Object>>();
                for (var instruction : code.get()) {
                    if (instruction instanceof LineNumber sourceLine) {
                        line = sourceLine.line();
                        first = Math.min(first, line);
                    } else if (line > 0 && instruction instanceof InvokeInstruction invoke) {
                        if (++totalCalls > 32000) throw new IllegalArgumentException("Mixed JVM invocation limit.");
                        calls.add(List.of("call", index, line, invoke.owner().asInternalName(),
                            invoke.name().stringValue(), invoke.type().stringValue()));
                    }
                }
                row("method", index, methodName, descriptor, first == Integer.MAX_VALUE ? 0 : first);
                for (var call : calls) row(call.toArray());
            }
        }
    }

    private static void row(Object... fields) {
        for (int index = 0; index < fields.length; index++) {
            if (index > 0) System.out.print('\t');
            String value = fields[index].toString();
            // Strings are limited to encodable class-file symbols and source file names.
            if (value.chars().anyMatch(character -> character < 32 || character == 127)) {
                throw new IllegalArgumentException("Invalid class-file metadata.");
            }
            System.out.print(value);
        }
        System.out.println();
    }
}
