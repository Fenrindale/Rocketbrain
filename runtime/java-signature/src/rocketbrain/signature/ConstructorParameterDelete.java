package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import java.io.IOException;
import java.util.*;
import static rocketbrain.signature.SignatureInspector.object;

/** Evidence for a selected constructor slot and its directly attributed Java calls. */
final class ConstructorParameterDelete {
    private record Selected(TreePath path, MethodTree declaration, ExecutableElement constructor, int ordinal) {}

    static Map<String, Object> inspect(JavacTask task, List<CompilationUnitTree> units, String uri, int caret)
            throws IOException {
        var trees = Trees.instance(task);
        var positions = trees.getSourcePositions();
        var matches = new ArrayList<Selected>();
        for (var unit : units) {
            if (!unit.getSourceFile().toUri().toString().equals(uri)) continue;
            new TreePathScanner<Void, Void>() {
                @Override public Void visitMethod(MethodTree declaration, Void unused) {
                    if (trees.getElement(getCurrentPath()) instanceof ExecutableElement constructor &&
                            constructor.getKind() == ElementKind.CONSTRUCTOR) {
                        for (int ordinal = 0; ordinal < declaration.getParameters().size(); ordinal++) {
                            var formal = declaration.getParameters().get(ordinal);
                            if (positions.getStartPosition(unit, formal) <= caret && caret <= positions.getEndPosition(unit, formal)) {
                                matches.add(new Selected(getCurrentPath(), declaration, constructor, ordinal));
                            }
                        }
                    }
                    return super.visitMethod(declaration, unused);
                }
            }.scan(unit, null);
        }
        if (matches.size() != 1) return object("state", "no-exact-parameter");
        var selection = matches.getFirst();
        var method = selection.constructor();
        var owner = (TypeElement) method.getEnclosingElement();
        if (owner.getKind() != ElementKind.CLASS || owner.getNestingKind() != NestingKind.TOP_LEVEL ||
                !owner.getSuperclass().toString().equals("java.lang.Object") || !owner.getInterfaces().isEmpty() ||
                !method.getModifiers().contains(Modifier.PRIVATE) || method.isVarArgs() ||
                !owner.getTypeParameters().isEmpty() || !method.getTypeParameters().isEmpty() ||
                selection.declaration().getReceiverParameter() != null) {
            return object("state", "unsupported-constructor");
        }
        if (!owner.getAnnotationMirrors().isEmpty() || !method.getAnnotationMirrors().isEmpty() ||
                method.getParameters().stream().anyMatch(formal -> !formal.getAnnotationMirrors().isEmpty() ||
                    !formal.asType().getAnnotationMirrors().isEmpty())) {
            return object("state", "annotated-constructor");
        }
        if (owner.getEnclosedElements().stream().filter(element -> element.getKind() == ElementKind.CONSTRUCTOR).count() != 1) {
            return object("state", "overloaded-constructor");
        }
        if (method.getParameters().size() > 30) return object("state", "unsupported-constructor");
        var key = SignatureInspector.key(method);
        var binding = ParameterNameBindings.inspect(task, units, Set.of(key), selection.ordinal()).getFirst();
        var declaration = selection.declaration();
        var unit = selection.path().getCompilationUnit();
        var arguments = new ArrayList<Map<String, Object>>();
        for (var peer : units) {
            var peerUri = peer.getSourceFile().toUri().toString();
            new TreePathScanner<Void, Void>() {
                private void add(Tree tree, List<? extends ExpressionTree> values, boolean direct) {
                    long start = positions.getStartPosition(peer, tree), end = positions.getEndPosition(peer, tree);
                    if (start < 0 || end <= start || arguments.size() > 200 || !method.equals(trees.getElement(getCurrentPath()))) return;
                    var removed = values.size() == method.getParameters().size() ? values.get(selection.ordinal()) : null;
                    var formal = method.getParameters().get(selection.ordinal()).asType();
                    boolean safe = direct && removed != null && discardable(trees, getCurrentPath(), removed, formal.getKind(), formal.toString());
                    arguments.add(object("uri", peerUri, "start", start, "end", end, "direct", direct,
                        "safeRemoved", safe, "arguments", values.stream().map(value -> span(positions, peer, value)).toList()));
                }
                @Override public Void visitNewClass(NewClassTree tree, Void unused) {
                    add(tree, tree.getArguments(), tree.getClassBody() == null && tree.getEnclosingExpression() == null);
                    return super.visitNewClass(tree, unused);
                }
                @Override public Void visitMethodInvocation(MethodInvocationTree tree, Void unused) {
                    add(tree, tree.getArguments(), false);
                    return super.visitMethodInvocation(tree, unused);
                }
            }.scan(peer, null);
        }
        return object("state", "attributed", "key", key, "ordinal", selection.ordinal(), "binding", binding,
            "start", positions.getStartPosition(unit, declaration), "end", positions.getEndPosition(unit, declaration),
            "formals", declaration.getParameters().stream().map(formal -> span(positions, unit, formal)).toList(),
            "calls", arguments);
    }

    private static Map<String,Object> span(SourcePositions positions, CompilationUnitTree unit, Tree tree) {
        return object("start", positions.getStartPosition(unit, tree), "end", positions.getEndPosition(unit, tree));
    }

    private static boolean discardable(Trees trees, TreePath caller, ExpressionTree expression, TypeKind kind, String type) {
        var argument = new TreePath(caller, expression);
        var mirror = trees.getTypeMirror(argument);
        if (mirror == null) return false;
        if (expression instanceof LiteralTree) {
            return kind.isPrimitive() && mirror.getKind().isPrimitive() ||
                type.equals("java.lang.String") && Set.of(Tree.Kind.STRING_LITERAL, Tree.Kind.NULL_LITERAL).contains(expression.getKind());
        }
        if (expression instanceof IdentifierTree && kind.isPrimitive() && mirror.getKind().isPrimitive() &&
                trees.getElement(argument) instanceof VariableElement variable) {
            return Set.of(ElementKind.LOCAL_VARIABLE, ElementKind.PARAMETER).contains(variable.getKind());
        }
        return false;
    }
}
