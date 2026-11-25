package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.IOException;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.Pattern;
import javax.lang.model.element.*;
import javax.lang.model.type.*;
import javax.lang.model.util.*;
import javax.tools.*;

/** Matches attributed project trees against a separately parsed, inert Java template. */
final class StructuralSearch {
    private static final Pattern CAPTURE = Pattern.compile("\\$([A-Za-z][A-Za-z0-9_]{0,47})\\$");
    private static final Set<TypeKind> VALUE_TYPES = EnumSet.of(TypeKind.BOOLEAN, TypeKind.BYTE, TypeKind.SHORT,
        TypeKind.INT, TypeKind.LONG, TypeKind.CHAR, TypeKind.FLOAT, TypeKind.DOUBLE, TypeKind.NULL,
        TypeKind.ARRAY, TypeKind.DECLARED, TypeKind.TYPEVAR, TypeKind.INTERSECTION);
    private static final int MATCH_LIMIT = 500;

    private record Shape(Object detail, List<? extends Tree> children) {}
    private record Occurrence(String name, int start, int end) {}
    private record Template(Tree tree, String source, List<Occurrence> occurrences) {
        Set<String> names() {
            var names = new LinkedHashSet<String>();
            for (var occurrence : occurrences) names.add(occurrence.name());
            return names;
        }
    }
    private record Constraint(TypeMirror type, boolean assignable) {}
    private record Bound(TreePath path, TypeMirror type) {}

    private final Trees trees;
    private final Types types;
    private final Elements elements;
    private final SourcePositions positions;

    StructuralSearch(JavacTask attributed) {
        trees = Trees.instance(attributed);
        types = attributed.getTypes();
        elements = attributed.getElements();
        positions = trees.getSourcePositions();
    }

    private static Shape shape(Object detail, Tree... children) {
        return new Shape(detail, Arrays.asList(children));
    }

    private static Shape shape(Tree node) {
        return switch (node) {
            case IdentifierTree identifier -> shape(identifier.getName().toString());
            case LiteralTree literal -> shape(literal.getValue());
            case MemberSelectTree select -> shape(select.getIdentifier().toString(), select.getExpression());
            case MethodInvocationTree call -> {
                var children = new ArrayList<Tree>();
                children.add(call.getMethodSelect());
                children.addAll(call.getTypeArguments());
                children.addAll(call.getArguments());
                yield new Shape(call.getTypeArguments().size(), children);
            }
            case NewClassTree constructor -> {
                if (constructor.getClassBody() != null) yield null;
                var children = new ArrayList<Tree>();
                children.add(constructor.getEnclosingExpression());
                children.add(constructor.getIdentifier());
                children.addAll(constructor.getTypeArguments());
                children.addAll(constructor.getArguments());
                yield new Shape(constructor.getTypeArguments().size(), children);
            }
            case BinaryTree binary -> shape(null, binary.getLeftOperand(), binary.getRightOperand());
            case UnaryTree unary -> shape(null, unary.getExpression());
            case ParenthesizedTree group -> shape(null, group.getExpression());
            case ConditionalExpressionTree condition ->
                shape(null, condition.getCondition(), condition.getTrueExpression(), condition.getFalseExpression());
            case AssignmentTree assignment -> shape(null, assignment.getVariable(), assignment.getExpression());
            case CompoundAssignmentTree assignment -> shape(null, assignment.getVariable(), assignment.getExpression());
            case ArrayAccessTree index -> shape(null, index.getExpression(), index.getIndex());
            case ArrayTypeTree array -> shape(null, array.getType());
            case ParameterizedTypeTree declared -> {
                var children = new ArrayList<Tree>();
                children.add(declared.getType());
                children.addAll(declared.getTypeArguments());
                yield new Shape(null, children);
            }
            case PrimitiveTypeTree primitive -> shape(primitive.getPrimitiveTypeKind());
            case TypeCastTree cast -> shape(null, cast.getType(), cast.getExpression());
            case InstanceOfTree check -> check.getPattern() == null ? shape(null, check.getExpression(), check.getType()) : null;
            case ExpressionStatementTree expression -> shape(null, expression.getExpression());
            case ReturnTree returning -> shape(null, returning.getExpression());
            case ThrowTree throwing -> shape(null, throwing.getExpression());
            case IfTree condition -> shape(null, condition.getCondition(), condition.getThenStatement(), condition.getElseStatement());
            case WhileLoopTree loop -> shape(null, loop.getCondition(), loop.getStatement());
            case DoWhileLoopTree loop -> shape(null, loop.getCondition(), loop.getStatement());
            case BlockTree block -> new Shape(block.isStatic(), block.getStatements());
            case BreakTree stop -> shape(Objects.toString(stop.getLabel(),null));
            case ContinueTree skip -> shape(Objects.toString(skip.getLabel(),null));
            case EmptyStatementTree unused -> new Shape(null,List.of());
            default -> null;
        };
    }

    private static String capture(Tree tree) {
        if (!(tree instanceof IdentifierTree identifier)) return null;
        var match = CAPTURE.matcher(identifier.getName());
        return match.matches() ? match.group(1) : null;
    }

    private static void inspectTemplate(Tree tree, CompilationUnitTree unit, SourcePositions positions,
            int prefix, List<Occurrence> occurrences, int depth) {
        if (tree == null) return;
        if (depth > 40) throw new IllegalArgumentException("The Java structural template is nested too deeply.");
        Shape shape = shape(tree);
        if (shape == null) throw new IllegalArgumentException("Unsupported Java structural template node: " + tree.getKind());
        String capture = capture(tree);
        if (capture != null) {
            int start = (int) positions.getStartPosition(unit, tree) - prefix;
            int end = (int) positions.getEndPosition(unit, tree) - prefix;
            occurrences.add(new Occurrence(capture, start, end));
        }
        for (var child : shape.children()) inspectTemplate(child, unit, positions, prefix, occurrences, depth + 1);
    }

    private static Template template(JavaCompiler compiler, JavaFileManager files, List<String> options, String mode,
            String raw) throws IOException {
        boolean expression = mode.equals("expression");
        String prefix = expression ? "class RbTemplate { Object pattern() { return (" : "class RbTemplate { void pattern() {\n";
        String suffix = expression ? "); } }" : "\n} }";
        var source = new SignatureInspector.Source("file:///RbTemplate.java", prefix + raw + suffix);
        var diagnostics = new DiagnosticCollector<JavaFileObject>();
        var task = (JavacTask) compiler.getTask(new StringWriter(), files, diagnostics, options, null, List.of(source));
        var unit = task.parse().iterator().next();
        var positions = Trees.instance(task).getSourcePositions();
        if (!SignatureInspector.errors(diagnostics).isEmpty() || unit.getTypeDecls().size() != 1 ||
                !(unit.getTypeDecls().getFirst() instanceof ClassTree owner) || owner.getMembers().size() != 1 ||
                !(owner.getMembers().getFirst() instanceof MethodTree method) || method.getBody() == null ||
                method.getBody().getStatements().size() != 1) {
            throw new IllegalArgumentException("Use one valid Java " + mode + " in the structural template.");
        }
        Tree tree = method.getBody().getStatements().getFirst();
        if (expression && tree instanceof ReturnTree statement && statement.getExpression() instanceof ParenthesizedTree outer) {
            tree = outer.getExpression();
        } else if (expression) {
            throw new IllegalArgumentException("Use one valid Java expression in the structural template.");
        }
        if (positions.getStartPosition(unit, tree) != prefix.length() ||
                positions.getEndPosition(unit, tree) != prefix.length() + raw.length()) {
            throw new IllegalArgumentException("Use one Java " + mode + " without leading or trailing comments.");
        }
        var occurrences = new ArrayList<Occurrence>();
        inspectTemplate(tree, unit, positions, prefix.length(), occurrences, 0);
        occurrences.sort(Comparator.comparingInt(Occurrence::start));
        return new Template(tree, raw, occurrences);
    }

    private TypeMirror type(String name) {
        if (name.endsWith("[]")) return types.getArrayType(type(name.substring(0,name.length() - 2)));
        for (var kind : TypeKind.values()) {
            if (kind.isPrimitive() && kind.name().toLowerCase(Locale.ROOT).equals(name)) return types.getPrimitiveType(kind);
        }
        TypeElement element = elements.getTypeElement(name);
        if (element == null) throw new IllegalArgumentException("Unresolved Java capture type: " + name);
        return types.erasure(element.asType());
    }

    private boolean match(Tree expected, TreePath candidate, Map<String,Constraint> constraints, Map<String,Bound> captures) {
        Tree tree = candidate.getLeaf();
        String name = capture(expected);
        if (name != null) {
            TypeMirror captured = expressionType(candidate,false);
            if (captured == null) return false;
            var constraint = constraints.get(name);
            if (constraint != null) {
                TypeMirror erased = types.erasure(captured);
                boolean fits = constraint.assignable() ? types.isAssignable(erased, constraint.type()) :
                    types.isSameType(erased, constraint.type());
                if (!fits) return false;
            }
            var previous = captures.putIfAbsent(name,new Bound(candidate,captured));
            return previous == null || equivalent(previous.path(),candidate,0);
        }
        if (expected.getKind() != tree.getKind()) return false;
        Shape a = shape(expected), b = shape(tree);
        if (!correspond(a,b)) return false;
        for (int index = 0; index < a.children().size(); index++) {
            Tree first = a.children().get(index), second = b.children().get(index);
            if (first == null || second == null) {
                if (first != second) return false;
            } else if (!match(first,new TreePath(candidate,second),constraints,captures)) return false;
        }
        return true;
    }

    private TypeMirror expressionType(TreePath candidate, boolean allowVoidCall) {
        if (!(candidate.getLeaf() instanceof ExpressionTree)) return null;
        TypeMirror typed = trees.getTypeMirror(candidate);
        Element symbol = trees.getElement(candidate);
        if (typed == null || symbol instanceof TypeElement || symbol instanceof PackageElement) return null;
        return VALUE_TYPES.contains(typed.getKind()) ||
            allowVoidCall && typed.getKind() == TypeKind.VOID && candidate.getLeaf() instanceof MethodInvocationTree ? typed : null;
    }

    private static boolean correspond(Shape a, Shape b) {
        return a != null && b != null && Objects.equals(a.detail(),b.detail()) && a.children().size() == b.children().size();
    }

    private boolean equivalent(TreePath first, TreePath second, int depth) {
        Tree a = first.getLeaf(), b = second.getLeaf();
        if (depth > 40 || a.getKind() != b.getKind()) return false;
        Shape left = shape(a), right = shape(b);
        if (!correspond(left,right) || a instanceof IdentifierTree && !Objects.equals(trees.getElement(first),trees.getElement(second)) ||
                a instanceof MemberSelectTree && !Objects.equals(trees.getElement(first),trees.getElement(second))) return false;
        for (int index = 0; index < left.children().size(); index++) {
            Tree x = left.children().get(index), y = right.children().get(index);
            if (x == null || y == null) {
                if (x != y) return false;
            } else if (!equivalent(new TreePath(first,x), new TreePath(second,y), depth + 1)) return false;
        }
        return true;
    }

    private boolean safeArgument(Bound bound) {
        TreePath path = bound.path();
        Tree tree = path.getLeaf();
        while (tree instanceof ParenthesizedTree group) {
            tree = group.getExpression();
            path = new TreePath(path, tree);
        }
        return SignatureInspector.safeArgument(path.getParentPath(), (ExpressionTree) tree, trees);
    }

    private Map<String,Object> item(TreePath path, String source, Template replacement, boolean expression,
            Map<String,Bound> captures) {
        var unit = path.getCompilationUnit();
        var node = path.getLeaf();
        int start = (int) positions.getStartPosition(unit,node), end = (int) positions.getEndPosition(unit,node);
        if (start < 0 || end <= start || end > source.length()) return null;
        var result = SignatureInspector.object("uri", unit.getSourceFile().toUri().toString(), "start", start, "end", end,
            "captures", captures.entrySet().stream().map(entry ->
                SignatureInspector.object("name",entry.getKey(),"type",entry.getValue().type().toString())).toList());
        if (replacement == null) return result;
        if (captures.values().stream().anyMatch(bound -> !safeArgument(bound))) {
            result.put("blocked","Replacement requires captured literals, local values, parameters or named constants.");
            return result;
        }
        var substituting = new StringBuilder();
        int cursor = 0;
        for (var occurrence : replacement.occurrences()) {
            Tree captured = captures.get(occurrence.name()).path().getLeaf();
            int from = (int) positions.getStartPosition(unit,captured), to = (int) positions.getEndPosition(unit,captured);
            if (from < start || to <= from || to > end || to - from > 8192) {
                result.put("blocked","A captured Java value has no bounded source span.");
                return result;
            }
            substituting.append(replacement.source(),cursor,occurrence.start()).append('(').append(source,from,to).append(')');
            cursor = occurrence.end();
        }
        substituting.append(replacement.source(),cursor,replacement.source().length());
        Tree parent = path.getParentPath().getLeaf();
        boolean needsGroup = expression && !(parent instanceof ExpressionStatementTree) &&
            !(parent instanceof LambdaExpressionTree lambda && lambda.getBody() == node);
        String edit = needsGroup ? "(" + substituting + ")" : substituting.toString();
        if (edit.getBytes(StandardCharsets.UTF_8).length > 8192) result.put("blocked","The replacement exceeds 8 KiB.");
        else result.put("replacement",edit);
        return result;
    }

    Map<String,Object> search(JavaCompiler compiler, JavaFileManager files, List<String> options, List<CompilationUnitTree> units,
            Map<String,SignatureInspector.Source> sources, String[] args) throws IOException {
        var matches = new ArrayList<Map<String,Object>>();
        try {
            String mode = args[5];
            Template pattern = template(compiler,files,options,mode,decode(args[6]));
            if (capture(pattern.tree()) != null) throw new IllegalArgumentException("Include a fixed Java structure around the capture.");
            Template replacement = args[7].isEmpty() ? null : template(compiler,files,options,mode,decode(args[7]));
            Set<String> names = pattern.names();
            if (replacement != null && !names.containsAll(replacement.names())) {
                throw new IllegalArgumentException("The replacement refers to a Java capture absent from the search template.");
            }
            Map<String,Constraint> constraints = new LinkedHashMap<>();
            for (int index = 9; index < args.length; index += 3) {
                String name = args[index];
                if (!names.contains(name)) throw new IllegalArgumentException("No $" + name + "$ capture exists in the search template.");
                constraints.put(name,new Constraint(type(args[index + 1]),args[index + 2].equals("assignable")));
            }
            boolean expression = mode.equals("expression");
            for (var unit : units) {
                String uri = unit.getSourceFile().toUri().toString();
                if (!args[8].isEmpty() && !args[8].equals(uri)) continue;
                String source = sources.get(uri).text;
                new TreePathScanner<Void,Void>() {
                    @Override public Void scan(Tree tree, Void unused) {
                        if (tree == null || matches.size() > MATCH_LIMIT) return null;
                        TreePath parent = getCurrentPath();
                        if (parent != null && tree.getKind() == pattern.tree().getKind()) {
                            TreePath candidate = new TreePath(parent,tree);
                            Map<String,Bound> bindings = new LinkedHashMap<>();
                            if ((!expression || expressionType(candidate,true) != null) &&
                                    match(pattern.tree(),candidate,constraints,bindings)) {
                                var found = item(candidate,source,replacement,expression,bindings);
                                if (found != null) matches.add(found);
                            }
                        }
                        return super.scan(tree,unused);
                    }
                }.scan(unit,null);
                if (matches.size() > MATCH_LIMIT) break;
            }
            return SignatureInspector.object("matches",matches.subList(0,Math.min(matches.size(),MATCH_LIMIT)),
                "truncated",matches.size() > MATCH_LIMIT);
        } catch (IllegalArgumentException invalid) {
            return SignatureInspector.object("matches",List.of(),"truncated",false,"error",invalid.getMessage());
        }
    }

    private static String decode(String encoded) {
        return new String(Base64.getDecoder().decode(encoded),StandardCharsets.UTF_8);
    }
}
