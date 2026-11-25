import java.lang.classfile.Attributes;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.CodeModel;
import java.lang.classfile.Instruction;
import java.lang.classfile.Label;
import java.lang.classfile.Opcode;
import java.lang.classfile.instruction.BranchInstruction;
import java.lang.classfile.instruction.LabelTarget;
import java.lang.classfile.instruction.LineNumber;
import java.lang.classfile.instruction.ReturnInstruction;
import java.lang.classfile.instruction.ThrowInstruction;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Reads debug line tables and proves two separate terminal arms without loading project classes. */
class BranchEvidence {
    private record Site(int line, Instruction instruction) {}
    private record Edge(int condition, int firstLine, int firstSize, int secondLine, int secondSize) {}

    private static Edge terminalArms(CodeModel code) {
        if (!code.exceptionHandlers().isEmpty()) return null;
        List<Site> instructions = new ArrayList<>();
        Map<Label, Integer> labels = new HashMap<>();
        int line = 0, branchIndex = -1;
        BranchInstruction branch = null;
        for (var element : code) {
            if (element instanceof LabelTarget target) {
                labels.put(target.label(), instructions.size());
            } else if (element instanceof LineNumber position) {
                line = position.line();
            } else if (element instanceof Instruction instruction) {
                Opcode opcode = instruction.opcode();
                if (opcode == Opcode.TABLESWITCH || opcode == Opcode.LOOKUPSWITCH || opcode == Opcode.JSR ||
                    opcode == Opcode.JSR_W || opcode == Opcode.RET || opcode == Opcode.RET_W) return null;
                if (instruction instanceof BranchInstruction jump) {
                    if (branch != null || opcode == Opcode.GOTO || opcode == Opcode.GOTO_W) return null;
                    branchIndex = instructions.size();
                    branch = jump;
                }
                instructions.add(new Site(line, instruction));
            }
        }
        if (branch == null) return null;
        int end = instructions.size(), first = branchIndex + 1;
        int second = labels.getOrDefault(branch.target(), -1);
        if (second <= first || second >= end) return null;
        int condition = instructions.get(branchIndex).line();
        int firstLine = instructions.get(first).line(), secondLine = instructions.get(second).line();
        if (condition <= 0 || firstLine <= condition || secondLine <= condition || firstLine == secondLine ||
            !singleLineExit(instructions, first, second) || !singleLineExit(instructions, second, end) ||
            instructions.subList(0, first).stream().anyMatch(site -> site.line() == firstLine || site.line() == secondLine)) return null;
        return new Edge(condition, firstLine, second - first, secondLine, end - second);
    }

    private static boolean singleLineExit(List<Site> instructions, int start, int end) {
        int line = instructions.get(start).line();
        for (int index = start; index < end; index++) {
            Site site = instructions.get(index);
            if (site.line() != line) return false;
            boolean exits = site.instruction() instanceof ReturnInstruction || site.instruction() instanceof ThrowInstruction;
            if (exits != (index == end - 1)) return false;
        }
        return true;
    }

    private static boolean field(String text) {
        return !text.isBlank() && text.indexOf('\t') < 0 && text.indexOf('\n') < 0 && text.indexOf('\r') < 0 && text.length() <= 1024;
    }

    public static void main(String[] arguments) throws Exception {
        ClassFile classFiles = ClassFile.of();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        int lines = 0, reported = 0;
        try (var input = Files.newBufferedReader(Path.of(arguments[0]))) {
            for (String row; (row = input.readLine()) != null; lines++) {
                if (lines >= 8000) throw new IllegalArgumentException("Class inventory limit");
                String[] entry = row.split("\t", -1);
                if (entry.length != 2) throw new IllegalArgumentException("Invalid class inventory");
                Path file = Path.of(URI.create(entry[0]));
                if (Files.size(file) > 4 * 1024 * 1024) continue;
                byte[] bytes = Files.readAllBytes(file);
                if (!HexFormat.of().formatHex(digest.digest(bytes)).equals(entry[1])) continue;
                ClassModel model = classFiles.parse(bytes);
                String owner = model.thisClass().asInternalName();
                String source = model.findAttribute(Attributes.sourceFile()).map(value -> value.sourceFile().stringValue()).orElse("");
                if (!field(owner) || !field(source) || source.contains("/") || source.contains("\\") || !source.endsWith(".java")) continue;
                String relative = owner.substring(0, owner.lastIndexOf('/') + 1) + source;
                for (var method : model.methods()) {
                    if (method.flags().has(java.lang.reflect.AccessFlag.SYNTHETIC) || method.flags().has(java.lang.reflect.AccessFlag.BRIDGE)) continue;
                    String name = method.methodName().stringValue(), descriptor = method.methodType().stringValue();
                    if (!field(name) || !field(descriptor)) continue;
                    Edge edge = method.code().map(BranchEvidence::terminalArms).orElse(null);
                    if (edge != null) {
                        if (++reported > 5000) throw new IllegalArgumentException("Branch evidence limit");
                        System.out.printf(Locale.ROOT, "branch\t%d\t%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d%n",
                            lines, relative, owner.replace('/', '.'), name, descriptor,
                            edge.condition(), edge.firstLine(), edge.firstSize(), edge.secondLine(), edge.secondSize());
                    }
                }
            }
        }
        System.out.println("complete");
    }
}
