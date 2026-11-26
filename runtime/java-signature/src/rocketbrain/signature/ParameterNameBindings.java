package rocketbrain.signature;

import java.io.IOException;
import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.VariableElement;
import com.sun.source.doctree.ParamTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.util.DocTrees;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import static rocketbrain.signature.SignatureInspector.object;

/** Finds only the chosen formal parameter's bound identifier and Javadoc spans. */
final class ParameterNameBindings {
    static List<Map<String,Object>> inspect(JavacTask task, List<CompilationUnitTree> units, Set<String> methods, int ordinal)
            throws IOException {
        var trees = Trees.instance(task);
        var docs = DocTrees.instance(task);
        var positions = trees.getSourcePositions();
        var names = new LinkedHashMap<String,Map<String,Object>>();
        for (var unit : units) {
            var source = unit.getSourceFile().getCharContent(true);
            var uri = unit.getSourceFile().toUri().toString();
            var active = new HashMap<Element,List<Map<String,Object>>>();
            new TreePathScanner<Void, Void>() {
                @Override public Void visitMethod(MethodTree declaration, Void unused) {
                    if (!(trees.getElement(getCurrentPath()) instanceof ExecutableElement method)) return super.visitMethod(declaration, unused);
                    var key = SignatureInspector.key(method);
                    if (!methods.contains(key)) return super.visitMethod(declaration, unused);
                    if (ordinal >= method.getParameters().size() || ordinal >= declaration.getParameters().size()) {
                        throw new IllegalArgumentException("The selected parameter slot is unavailable.");
                    }
                    VariableElement parameter = method.getParameters().get(ordinal);
                    String name = parameter.getSimpleName().toString();
                    var syntax = declaration.getParameters().get(ordinal);
                    long afterType = positions.getEndPosition(unit, syntax.getType());
                    long end = positions.getEndPosition(unit, syntax);
                    if (afterType < 0 || end <= afterType || end > source.length()) {
                        throw new IllegalArgumentException("The selected formal name has no exact source span.");
                    }
                    var matcher = Pattern.compile("^\\s*(" + Pattern.quote(name) + ")\\s*$")
                        .matcher(source.subSequence((int) afterType, (int) end));
                    if (!matcher.find()) throw new IllegalArgumentException("Use a plain formal name with an exact source span.");
                    var spans = new ArrayList<Map<String,Object>>();
                    spans.add(object("kind", "declaration", "start", afterType + matcher.start(1), "end", afterType + matcher.end(1)));
                    var comment = docs.getDocCommentTree(getCurrentPath());
                    if (comment != null) for (var tag : comment.getBlockTags()) {
                        if (!(tag instanceof ParamTree param) || param.isTypeParameter() || !param.getName().getName().contentEquals(name)) continue;
                        var word = param.getName();
                        var docPositions = docs.getSourcePositions();
                        add(spans, "javadoc", docPositions.getStartPosition(unit, comment, word),
                            docPositions.getEndPosition(unit, comment, word), name);
                    }
                    if (names.putIfAbsent(key, object("key", key, "uri", uri, "name", name, "spans", spans)) != null) {
                        throw new IllegalArgumentException("The compiler found an ambiguous formal declaration.");
                    }
                    active.put(parameter, spans);
                    try { return super.visitMethod(declaration, unused); }
                    finally { active.remove(parameter); }
                }

                @Override public Void visitIdentifier(IdentifierTree expression, Void unused) {
                    if (!active.isEmpty()) {
                        var spans = active.get(trees.getElement(getCurrentPath()));
                        if (spans != null) {
                            add(spans, "reference", positions.getStartPosition(unit, expression),
                                positions.getEndPosition(unit, expression), expression.getName().toString());
                        }
                    }
                    return super.visitIdentifier(expression, unused);
                }

                private void add(List<Map<String,Object>> spans, String kind, long start, long end, String name) {
                    if (spans.size() >= 160 || start < 0 || end - start != name.length() || end > source.length() ||
                            !source.subSequence((int) start, (int) end).toString().equals(name)) {
                        throw new IllegalArgumentException("A parameter use exceeds the exact source review boundary.");
                    }
                    spans.add(object("kind", kind, "start", start, "end", end));
                }
            }.scan(unit, null);
        }
        if (!names.keySet().equals(methods)) throw new IllegalArgumentException("The parameter declaration family is incomplete.");
        return new ArrayList<>(names.values());
    }
}
