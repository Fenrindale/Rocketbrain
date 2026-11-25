package rocketbrain.signature;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.NestingKind;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeMirror;
import com.sun.source.tree.*;
import com.sun.source.util.JavacTask;
import com.sun.source.util.SourcePositions;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import static rocketbrain.signature.SignatureInspector.object;

/** Checks the original expression and the selected reference after editing. */
final class ConstantInspector {
    private final CompilationUnitTree unit;
    private final JavacTask task;
    private final Trees trees;
    private final SourcePositions positions;

    ConstantInspector(JavacTask task, CompilationUnitTree unit) {
        this.unit = unit;
        this.task = task;
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
    }

    private long start(Tree tree) { return positions.getStartPosition(unit, tree); }
    private long end(Tree tree) { return positions.getEndPosition(unit, tree); }

    private TreePath at(int from, int to) {
        var result = new TreePath[1];
        new TreePathScanner<Void, Void>() {
            @Override public Void scan(Tree tree, Void ignored) {
                if (tree == null || result[0] != null) return null;
                TreePath parent = getCurrentPath();
                if (parent != null && tree instanceof ExpressionTree && start(tree) == from && end(tree) == to) {
                    result[0] = new TreePath(parent, tree);
                    return null;
                }
                return super.scan(tree, ignored);
            }
        }.scan(unit, null);
        return result[0];
    }

    private static String scalar(TypeMirror type) {
        if (type == null) return null;
        return type.getKind().isPrimitive() || type.toString().equals("java.lang.String") ? type.toString() : null;
    }

    private boolean constantOperands(TreePath path, List<String> bindings, int depth) {
        if (depth > 96) return false;
        Tree tree = path.getLeaf();
        return switch (tree.getKind()) {
            case BOOLEAN_LITERAL, CHAR_LITERAL, INT_LITERAL, LONG_LITERAL, FLOAT_LITERAL, DOUBLE_LITERAL, STRING_LITERAL -> true;
            case IDENTIFIER -> constantField(path, bindings);
            case MEMBER_SELECT -> trees.getElement(new TreePath(path, ((MemberSelectTree) tree).getExpression())) instanceof TypeElement
                && constantField(path, bindings);
            case PARENTHESIZED -> constantOperands(new TreePath(path, ((ParenthesizedTree) tree).getExpression()), bindings, depth + 1);
            case UNARY_PLUS, UNARY_MINUS, BITWISE_COMPLEMENT, LOGICAL_COMPLEMENT ->
                constantOperands(new TreePath(path, ((UnaryTree) tree).getExpression()), bindings, depth + 1);
            case MULTIPLY, DIVIDE, REMAINDER, PLUS, MINUS, LEFT_SHIFT, RIGHT_SHIFT, UNSIGNED_RIGHT_SHIFT,
                LESS_THAN, GREATER_THAN, LESS_THAN_EQUAL, GREATER_THAN_EQUAL, EQUAL_TO, NOT_EQUAL_TO, AND, XOR, OR,
                CONDITIONAL_AND, CONDITIONAL_OR -> {
                BinaryTree binary = (BinaryTree) tree;
                yield constantOperands(new TreePath(path, binary.getLeftOperand()), bindings, depth + 1)
                    && constantOperands(new TreePath(path, binary.getRightOperand()), bindings, depth + 1);
            }
            case CONDITIONAL_EXPRESSION -> {
                ConditionalExpressionTree choice = (ConditionalExpressionTree) tree;
                yield constantOperands(new TreePath(path, choice.getCondition()), bindings, depth + 1)
                    && constantOperands(new TreePath(path, choice.getTrueExpression()), bindings, depth + 1)
                    && constantOperands(new TreePath(path, choice.getFalseExpression()), bindings, depth + 1);
            }
            case TYPE_CAST -> {
                TypeCastTree cast = (TypeCastTree) tree;
                yield scalar(trees.getTypeMirror(new TreePath(path, cast.getType()))) != null
                    && constantOperands(new TreePath(path, cast.getExpression()), bindings, depth + 1);
            }
            default -> false;
        };
    }

    private boolean constantField(TreePath path, List<String> bindings) {
        Element element = trees.getElement(path);
        if (!(element instanceof VariableElement field) || field.getKind() != ElementKind.FIELD ||
                !field.getModifiers().contains(Modifier.STATIC) || field.getConstantValue() == null ||
                !(field.getEnclosingElement() instanceof TypeElement owner)) return false;
        bindings.add(owner.getQualifiedName() + "#" + field.getSimpleName() + ":" + field.asType());
        return true;
    }

    private Set<String> occupiedNames(TypeElement owner) {
        var names = new LinkedHashSet<String>();
        for (Element member : task.getElements().getAllMembers(owner)) {
            if (member.getKind().isField()) names.add(member.getSimpleName().toString());
        }
        new TreePathScanner<Void, Void>() {
            @Override public Void visitIdentifier(IdentifierTree tree, Void ignored) {
                names.add(tree.getName().toString());
                return super.visitIdentifier(tree, ignored);
            }
            @Override public Void visitVariable(VariableTree tree, Void ignored) {
                names.add(tree.getName().toString());
                return super.visitVariable(tree, ignored);
            }
        }.scan(unit, null);
        return names;
    }

    Map<String, Object> inspect(int from, int to, String expectedName) {
        TreePath selected = at(from, to);
        if (selected == null) return object("error", "Select exactly one Java expression.");
        String type = scalar(trees.getTypeMirror(selected));
        if (type == null) return object("error", "Choose a primitive or String compile-time expression.");
        TreePath container = selected;
        while (container != null && !(container.getLeaf() instanceof ClassTree)) container = container.getParentPath();
        if (container == null || !(trees.getElement(container) instanceof TypeElement owner) || owner.getKind() != ElementKind.CLASS ||
                !Set.of(NestingKind.TOP_LEVEL, NestingKind.MEMBER).contains(owner.getNestingKind())) {
            return object("error", "Select an expression inside a named Java class.");
        }
        List<String> bindings = new ArrayList<>();
        if (expectedName.isEmpty()) {
            if (!constantOperands(selected, bindings, 0)) {
                return object("error", "Choose a compile-time expression using literals and static constant fields. Calls, mutable values and local variables cannot be moved to this field.");
            }
            return object("type", type, "owner", owner.getQualifiedName().toString(), "classStart", start(container.getLeaf()),
                "bindings", bindings, "occupiedNames", occupiedNames(owner));
        }
        Element element = trees.getElement(selected);
        if (!(selected.getLeaf() instanceof IdentifierTree) || !(element instanceof VariableElement field) ||
                field.getKind() != ElementKind.FIELD || !field.getSimpleName().contentEquals(expectedName) ||
                !owner.equals(field.getEnclosingElement()) || !field.getModifiers().equals(Set.of(Modifier.PRIVATE, Modifier.STATIC, Modifier.FINAL)) ||
                field.getConstantValue() == null) return object("error", "The selected use does not resolve to the new private static final compile-time constant.");
        TreePath declaration = trees.getPath(field);
        if (declaration == null || declaration.getCompilationUnit() != unit || !(declaration.getLeaf() instanceof VariableTree variable) ||
                variable.getInitializer() == null || !constantOperands(new TreePath(declaration, variable.getInitializer()), bindings, 0)) {
            return object("error", "The constant initializer does not preserve its checked static field bindings.");
        }
        return object("type", type, "owner", owner.getQualifiedName().toString(), "bindings", bindings,
            "declarationStart", start(variable), "initializerStart", start(variable.getInitializer()), "initializerEnd", end(variable.getInitializer()));
    }
}
