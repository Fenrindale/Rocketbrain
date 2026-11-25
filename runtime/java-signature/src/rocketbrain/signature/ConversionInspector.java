package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.Elements;

import static rocketbrain.signature.SignatureInspector.object;

/** Proves the supported initializer and loop shapes against actual javac bindings. */
final class ConversionInspector {
    private final Trees trees;
    private final Elements elements;
    private final SourcePositions positions;
    private final CompilationUnitTree unit;
    private final String text;
    private final Map<Element, List<TreePath>> references = new HashMap<>();

    ConversionInspector(JavacTask task, CompilationUnitTree unit, String text) {
        this.trees = Trees.instance(task);
        this.elements = task.getElements();
        this.positions = trees.getSourcePositions();
        this.unit = unit;
        this.text = text;
    }

    private TreePath path(TreePath parent, Tree child) { return new TreePath(parent, child); }
    private int start(Tree tree) { return (int) positions.getStartPosition(unit, tree); }
    private int end(Tree tree) { return (int) positions.getEndPosition(unit, tree); }
    private Element element(TreePath parent, Tree child) { return trees.getElement(path(parent, child)); }

    List<Map<String, Object>> inspect() {
        new TreePathScanner<Void, Void>() {
            @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                Element target = trees.getElement(getCurrentPath());
                if (target != null) references.computeIfAbsent(target, key -> new ArrayList<>()).add(getCurrentPath());
                return super.visitIdentifier(node, unused);
            }
        }.scan(unit, null);

        var result = new ArrayList<Map<String, Object>>();
        new TreePathScanner<Void, Void>() {
            void add(Map<String, Object> site) {
                if (site != null) result.add(site);
                if (result.size() > 400) throw new IllegalArgumentException("Too many supported Java conversion sites in this file.");
            }
            @Override public Void visitVariable(VariableTree node, Void unused) {
                add(function(getCurrentPath(), node));
                return super.visitVariable(node, unused);
            }
            @Override public Void visitForLoop(ForLoopTree node, Void unused) {
                add(indexedLoop(getCurrentPath(), node));
                return super.visitForLoop(node, unused);
            }
            @Override public Void visitEnhancedForLoop(EnhancedForLoopTree node, Void unused) {
                add(enhancedLoop(getCurrentPath(), node));
                return super.visitEnhancedForLoop(node, unused);
            }
        }.scan(unit, null);
        return result;
    }

    private static boolean local(Element element) {
        return element instanceof VariableElement && Set.of(ElementKind.LOCAL_VARIABLE, ElementKind.PARAMETER).contains(element.getKind());
    }

    private ExecutableElement sam(VariableElement variable) {
        if (!(variable.asType() instanceof DeclaredType declared) || !(declared.asElement() instanceof TypeElement type) ||
                !elements.isFunctionalInterface(type)) return null;
        String name = type.getQualifiedName().toString();
        if (!name.startsWith("java.util.function.") && !Set.of("java.lang.Runnable", "java.util.concurrent.Callable").contains(name)) return null;
        var methods = elements.getAllMembers(type).stream()
            .filter(member -> member instanceof ExecutableElement && member.getModifiers().contains(Modifier.ABSTRACT)).toList();
        return methods.size() == 1 ? (ExecutableElement) methods.getFirst() : null;
    }

    private static Tree executionBoundary(TreePath path) {
        for (; path != null; path = path.getParentPath()) {
            Tree node = path.getLeaf();
            if (node instanceof MethodTree || node instanceof LambdaExpressionTree || node instanceof ClassTree) return node;
        }
        return null;
    }

    private boolean directCalls(TreePath site, VariableElement variable, ExecutableElement method) {
        Tree boundary = executionBoundary(site);
        for (var use : references.getOrDefault(variable, List.of())) {
            TreePath selection = use.getParentPath(), invocation = selection.getParentPath();
            if (executionBoundary(use) != boundary ||
                    !(selection.getLeaf() instanceof MemberSelectTree select) || select.getExpression() != use.getLeaf() ||
                    !(invocation.getLeaf() instanceof MethodInvocationTree call) || call.getMethodSelect() != select ||
                    !method.equals(trees.getElement(selection))) return false;
        }
        return true;
    }

    private Map<String, Object> function(TreePath site, VariableTree declaration) {
        if (!(trees.getElement(site) instanceof VariableElement variable) || variable.getKind() != ElementKind.LOCAL_VARIABLE ||
                declaration.getType() == null || start(declaration.getType()) < 0 || end(declaration.getType()) <= start(declaration.getType())) return null;
        Tree initializer = declaration.getInitializer();
        if (!(initializer instanceof LambdaExpressionTree || initializer instanceof NewClassTree) ||
                start(initializer) < 0 || end(initializer) <= start(initializer)) return null;
        ExecutableElement method = sam(variable);
        if (method == null || !directCalls(site, variable, method)) return null;

        TreePath initPath = path(site, initializer), bodyPath;
        List<? extends VariableTree> parameters;
        String kind;
        int actionOffset;
        if (initializer instanceof LambdaExpressionTree lambda) {
            kind = "lambda";
            parameters = lambda.getParameters();
            bodyPath = path(initPath, lambda.getBody());
            actionOffset = text.lastIndexOf("->", start(lambda.getBody())) + 1;
            if (actionOffset <= start(initializer)) return null;
        } else {
            kind = "anonymous";
            var created = (NewClassTree) initializer;
            if (created.getClassBody() == null || created.getEnclosingExpression() != null || !created.getArguments().isEmpty()) return null;
            TreePath bodyClass = path(initPath, created.getClassBody());
            if (!trees.getTypeMirror(path(initPath, created.getIdentifier())).toString().equals(variable.asType().toString())) return null;
            var members = created.getClassBody().getMembers().stream().filter(member -> end(member) > start(member)).toList();
            if (members.size() != 1 || !(members.getFirst() instanceof MethodTree implementation) ||
                    !implementation.getName().contentEquals(method.getSimpleName()) || implementation.getBody() == null ||
                    !(trees.getElement(path(bodyClass, implementation)) instanceof ExecutableElement executor) ||
                    !executor.getModifiers().equals(Set.of(Modifier.PUBLIC)) ||
                    executor.getAnnotationMirrors().stream().anyMatch(annotation -> !annotation.getAnnotationType().toString().equals("java.lang.Override"))) return null;
            parameters = implementation.getParameters();
            bodyPath = path(path(bodyClass, implementation), implementation.getBody());
            actionOffset = start(initializer) + 4;
        }
        TreePath paramsParent = kind.equals("lambda") ? initPath : bodyPath.getParentPath();
        var parameterBindings = new LinkedHashMap<Element, String>();
        for (var parameter : parameters) {
            Element binding = element(paramsParent, parameter);
            if (!(binding instanceof VariableElement param) || !param.getAnnotationMirrors().isEmpty() ||
                    !param.asType().getAnnotationMirrors().isEmpty()) return null;
            parameterBindings.put(param, param.getSimpleName() + ":" + param.asType());
        }
        TreePath normalized = normalizeBody(bodyPath, method.getReturnType().getKind() == TypeKind.VOID);
        if (normalized == null) return null;
        var bindings = bodyBindings(normalized, parameterBindings);
        if (bindings == null) return null;
        return object("kind", kind, "start", start(initializer), "end", end(initializer), "cursorStart", start(declaration),
            "actionOffset", actionOffset, "sam", SignatureInspector.key(method), "type", variable.asType().toString(),
            "parameters", parameterBindings.values(), "body", normalized.getLeaf().toString(),
            "bindings", bindings);
    }

    private TreePath normalizeBody(TreePath body, boolean isVoid) {
        if (!(body.getLeaf() instanceof BlockTree block)) return body;
        if (block.getStatements().isEmpty() && isVoid) return body;
        if (block.getStatements().size() != 1) return null;
        StatementTree statement = block.getStatements().getFirst();
        Tree expression = statement instanceof ReturnTree value && !isVoid ? value.getExpression() :
            statement instanceof ExpressionStatementTree value && isVoid ? value.getExpression() : null;
        return expression == null ? null : path(path(body, statement), expression);
    }

    private List<String> bodyBindings(TreePath body, Map<Element, String> parameters) {
        var bindings = new ArrayList<String>();
        var unsafe = new boolean[1];
        new TreePathScanner<Void, Void>() {
            void keep(Tree node, String name, boolean qualified) {
                Element target = trees.getElement(getCurrentPath());
                TypeMirror type = trees.getTypeMirror(getCurrentPath());
                if (name.equals("this") || name.equals("super") || target == null || type == null ||
                        !qualified && (target.getKind().isField() || target instanceof ExecutableElement) &&
                        !target.getModifiers().contains(Modifier.STATIC)) {
                    unsafe[0] = true;
                    return;
                }
                String key;
                if (parameters.containsKey(target)) key = "parameter:" + parameters.get(target);
                else if (target instanceof ExecutableElement method) key = SignatureInspector.key(method);
                else key = target.getKind() + ":" + target.getEnclosingElement() + ":" + target;
                bindings.add(node.getKind() + ":" + key + ":" + type);
            }
            @Override public Void visitIdentifier(IdentifierTree node, Void unused) {
                keep(node, node.getName().toString(), false);
                return super.visitIdentifier(node, unused);
            }
            @Override public Void visitMemberSelect(MemberSelectTree node, Void unused) {
                keep(node, node.getIdentifier().toString(), true);
                return super.visitMemberSelect(node, unused);
            }
            @Override public Void visitLambdaExpression(LambdaExpressionTree node, Void unused) { unsafe[0] = true; return null; }
            @Override public Void visitNewClass(NewClassTree node, Void unused) { unsafe[0] = true; return null; }
            @Override public Void visitMemberReference(MemberReferenceTree node, Void unused) { unsafe[0] = true; return null; }
        }.scan(body, null);
        return unsafe[0] ? null : bindings;
    }

    private record Accumulation(Element accumulator, TreePath value) {}

    private Accumulation accumulation(TreePath loop, StatementTree statement) {
        TreePath body = path(loop, statement);
        if (statement instanceof BlockTree block) {
            if (block.getStatements().size() != 1) return null;
            body = path(body, block.getStatements().getFirst());
        }
        if (!(body.getLeaf() instanceof ExpressionStatementTree expression) ||
                !(expression.getExpression() instanceof CompoundAssignmentTree assignment) ||
                assignment.getKind() != Tree.Kind.PLUS_ASSIGNMENT || !(assignment.getVariable() instanceof IdentifierTree)) return null;
        TreePath operation = path(body, assignment);
        Element accumulator = element(operation, assignment.getVariable());
        if (!local(accumulator) || !accumulator.asType().getKind().isPrimitive() ||
                accumulator.asType().getKind() == TypeKind.BOOLEAN) return null;
        return new Accumulation(accumulator, path(operation, assignment.getExpression()));
    }

    private Element primitiveArray(TreePath parent, Tree tree) {
        if (!(tree instanceof IdentifierTree)) return null;
        Element array = element(parent, tree);
        return local(array) && array.asType() instanceof ArrayType type &&
            type.getComponentType().getKind().isPrimitive() && type.getComponentType().getKind() != TypeKind.BOOLEAN ? array : null;
    }

    private Map<String, Object> indexedLoop(TreePath site, ForLoopTree loop) {
        if (loop.getInitializer().size() != 1 || !(loop.getInitializer().getFirst() instanceof VariableTree variable) ||
                !(variable.getInitializer() instanceof LiteralTree literal) || !Integer.valueOf(0).equals(literal.getValue()) ||
                !(loop.getCondition() instanceof BinaryTree less) || less.getKind() != Tree.Kind.LESS_THAN ||
                !(less.getLeftOperand() instanceof IdentifierTree) || !(less.getRightOperand() instanceof MemberSelectTree length) ||
                !length.getIdentifier().contentEquals("length") || loop.getUpdate().size() != 1 ||
                !(loop.getUpdate().getFirst().getExpression() instanceof UnaryTree increment) ||
                !Set.of(Tree.Kind.POSTFIX_INCREMENT, Tree.Kind.PREFIX_INCREMENT).contains(increment.getKind())) return null;
        Element index = element(site, variable);
        if (!local(index) || index.asType().getKind() != TypeKind.INT ||
                !index.equals(element(path(site, less), less.getLeftOperand())) ||
                !index.equals(element(path(path(site, loop.getUpdate().getFirst()), increment), increment.getExpression()))) return null;
        Element array = primitiveArray(path(path(site, less), length), length.getExpression());
        Accumulation accumulation = accumulation(site, loop.getStatement());
        if (array == null || accumulation == null || index.equals(accumulation.accumulator()) ||
                !(accumulation.value().getLeaf() instanceof ArrayAccessTree access) ||
                !array.equals(primitiveArray(accumulation.value(), access.getExpression())) ||
                !index.equals(element(accumulation.value(), access.getIndex()))) return null;
        return loopSite("indexed", loop, array, accumulation.accumulator());
    }

    private Map<String, Object> enhancedLoop(TreePath site, EnhancedForLoopTree loop) {
        Element array = primitiveArray(site, loop.getExpression());
        Element variable = element(site, loop.getVariable());
        Accumulation accumulation = accumulation(site, loop.getStatement());
        if (array == null || !local(variable) ||
                !((ArrayType) array.asType()).getComponentType().toString().equals(variable.asType().toString()) ||
                accumulation == null || variable.equals(accumulation.accumulator()) ||
                !(accumulation.value().getLeaf() instanceof IdentifierTree) ||
                !variable.equals(trees.getElement(accumulation.value()))) return null;
        return loopSite("enhanced", loop, array, accumulation.accumulator());
    }

    private Map<String, Object> loopSite(String kind, Tree loop, Element array, Element accumulator) {
        return object("kind", kind, "start", start(loop), "end", end(loop), "cursorStart", start(loop),
            "actionOffset", start(loop) + 1, "array", array.getSimpleName().toString(), "arrayType", array.asType().toString(),
            "accumulator", accumulator.getSimpleName().toString(), "accumulatorType", accumulator.asType().toString());
    }
}
