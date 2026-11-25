package rocketbrain.signature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeMirror;
import com.sun.source.tree.*;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Plans bounded deletions and fingerprints the attributed source independently of them. */
final class CleanupInspector {
    private static final Pattern IDENTIFIER = Pattern.compile("\\p{javaJavaIdentifierStart}\\p{javaJavaIdentifierPart}*");
    private static final Pattern CAPTURE = Pattern.compile("capture#\\d+");
    private final CompilationUnitTree unit;
    private final Trees trees;
    private final SourcePositions positions;
    private final String source;
    private final boolean recipes;
    private final MessageDigest fingerprint;
    private final List<Map<String, Object>> findings = new ArrayList<>();

    CleanupInspector(CompilationUnitTree unit, Trees trees, String source, boolean recipes) throws NoSuchAlgorithmException {
        this.unit = unit;
        this.trees = trees;
        this.positions = trees.getSourcePositions();
        this.source = source;
        this.recipes = recipes;
        fingerprint = MessageDigest.getInstance("SHA-256");
    }

    private int start(Tree tree) { return (int) positions.getStartPosition(unit, tree); }
    private int end(Tree tree) { return (int) positions.getEndPosition(unit, tree); }

    private void record(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        fingerprint.update(Integer.toString(bytes.length).getBytes(StandardCharsets.US_ASCII));
        fingerprint.update((byte) ':');
        fingerprint.update(bytes);
    }

    @SafeVarargs
    private final void finding(String kind, Map<String, Object>... edits) {
        if (findings.size() >= 2000) throw new IllegalArgumentException("Java cleanup exceeds its bounded finding limit.");
        findings.add(object("kind", kind, "edits", List.of(edits)));
    }

    private static Map<String, Object> edit(int first, int last, String replacement) {
        return object("start", first, "end", last, "newText", replacement);
    }

    private void unusedImports() {
        var identifiers = new HashMap<String, Integer>();
        var matches = IDENTIFIER.matcher(source);
        while (matches.find()) identifiers.merge(matches.group(), 1, Integer::sum);
        for (ImportTree node : unit.getImports()) {
            if (node.isStatic() || !(node.getQualifiedIdentifier() instanceof MemberSelectTree reference)) continue;
            String name = reference.getIdentifier().toString();
            // Count comments and documentation too, so this never drops a potential Javadoc name binding.
            if (identifiers.getOrDefault(name, 0) != 1) continue;
            int first = start(node), last = end(node);
            if (first < 0 || last <= first || last > source.length()) continue;
            String original = source.substring(first, last);
            if (original.contains("//") || original.contains("/*") || original.contains("\r") || original.contains("\n")) continue;
            int line = source.lastIndexOf('\n', first - 1) + 1, newline = source.indexOf('\n', last);
            if (newline >= 0 && source.substring(line, first).isBlank() && source.substring(last, newline).isBlank()) {
                first = line;
                last = newline + 1;
            }
            finding("unused-type-import", edit(first, last, ""));
        }
    }

    private static boolean delimited(Tree parent, Tree child) {
        if (parent instanceof ParenthesizedTree) return true;
        if (parent instanceof ReturnTree node) return node.getExpression() == child;
        if (parent instanceof ThrowTree node) return node.getExpression() == child;
        if (parent instanceof YieldTree node) return node.getValue() == child;
        if (parent instanceof VariableTree node) return node.getInitializer() == child;
        if (parent instanceof MethodInvocationTree node) return node.getArguments().contains(child);
        if (parent instanceof NewClassTree node) return node.getArguments().contains(child);
        return false;
    }

    private void parentheses(Tree node, Tree parent) {
        if (!delimited(parent, node)) return;
        int first = start(node), last = end(node);
        if (first < 0 || last - first < 3 || last > source.length() ||
                source.charAt(first) != '(' || source.charAt(last - 1) != ')') return;
        // In `return(value)` the opening delimiter separates the Java keyword and value.
        String separator = first > 0 && Character.isJavaIdentifierPart(source.codePointBefore(first)) ? " " : "";
        finding("redundant-parentheses", edit(first, first + 1, separator), edit(last - 1, last, ""));
    }

    private static String typeName(TypeMirror mirror) {
        return mirror == null ? "" : CAPTURE.matcher(mirror.toString()).replaceAll("capture");
    }

    private static String binding(Element element) {
        if (element == null) return "";
        if (element instanceof ExecutableElement executable) return SignatureInspector.key(executable);
        if (element instanceof TypeElement type && !type.getQualifiedName().isEmpty()) return type.getQualifiedName().toString();
        Element owner = element.getEnclosingElement();
        return element.getKind() + ":" + (owner instanceof ExecutableElement method ? SignatureInspector.key(method) : owner) +
            ":" + element.getSimpleName() + ":" + typeName(element.asType());
    }

    Map<String, Object> inspect() {
        // Java translates Unicode escapes before lexing. A recipe needs the original raw delimiters.
        boolean lexical = !source.contains("\\u");
        if (recipes && lexical) unusedImports();
        new TreePathScanner<Void, Void>() {
            @Override public Void scan(Tree node, Void unused) {
                if (node == null || node instanceof ImportTree) return null;
                TreePath parentPath = getCurrentPath();
                Tree parent = parentPath == null ? null : parentPath.getLeaf();
                if (node instanceof ParenthesizedTree) {
                    if (recipes && lexical) parentheses(node, parent);
                    return super.scan(node, unused);
                }
                if (node instanceof EmptyStatementTree && parent instanceof BlockTree) {
                    int first = start(node), last = end(node);
                    if (recipes && lexical && first >= 0 && last == first + 1 && last <= source.length() && source.charAt(first) == ';') {
                        finding("empty-block-statement", edit(first, last, ""));
                    }
                    return null;
                }
                record("open");
                record(node.getKind().name());
                if (parentPath != null && node instanceof ExpressionTree) {
                    TreePath path = new TreePath(parentPath, node);
                    record(typeName(trees.getTypeMirror(path)));
                    record(binding(trees.getElement(path)));
                }
                if (node instanceof LiteralTree literal) record(String.valueOf(literal.getValue()));
                if (node instanceof IdentifierTree identifier) record(identifier.getName().toString());
                if (node instanceof MemberSelectTree member) record(member.getIdentifier().toString());
                Void result = super.scan(node, unused);
                record("close");
                return result;
            }
        }.scan(unit, null);
        return object("fingerprint", HexFormat.of().formatHex(fingerprint.digest()), "findings", findings, "lexical", lexical);
    }
}
