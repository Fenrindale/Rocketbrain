package rocketbrain.signature;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import javax.lang.model.element.Element;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.TypeKind;
import com.sun.source.tree.AssignmentTree;
import com.sun.source.tree.BinaryTree;
import com.sun.source.tree.BlockTree;
import com.sun.source.tree.ExpressionStatementTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.LiteralTree;
import com.sun.source.tree.ParenthesizedTree;
import com.sun.source.tree.ReturnTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.UnaryTree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.TreePath;
import rocketbrain.signature.SignatureInspector.Flow;

/** Walks bounded structured statements, keeping reaching definitions per normal arm. */
final class BranchFlow {
    private record Arm(Map<Element,Integer> definitions, List<Integer> controls) {}
    private final Flow flow;
    private final List<Integer> returns = new ArrayList<>();
    private final Map<Integer,Integer> assumptions = new HashMap<>();

    BranchFlow(Flow flow) { this.flow = flow; }

    int trace(TreePath body) {
        visit(body,0);
        if (returns.isEmpty()) return -1;
        if (returns.size()==1) return returns.getFirst();
        int close=flow.end(body.getLeaf());
        Object joined=flow.fact(returns.getFirst());
        for (int value : returns) joined=FlowFacts.common(joined,flow.fact(value));
        return flow.valueEvent("return-merge","Possible method returns",close-1,close,returns,joined);
    }

    private boolean visit(TreePath route, int depth) {
        if (depth > 12) throw new UnsupportedOperationException("Java call flow exceeds its structured branch depth limit.");
        Tree tree=route.getLeaf();
        if (tree instanceof BlockTree block) {
            var before=new LinkedHashMap<>(flow.definitions);
            for (StatementTree statement : block.getStatements()) {
                if (!visit(new TreePath(route,statement),depth+1)) return false;
            }
            flow.definitions.keySet().retainAll(before.keySet());
        } else if (tree instanceof VariableTree local) {
            flow.declaration(route,local,false,List.of());
        } else if (tree instanceof ExpressionStatementTree expr && expr.getExpression() instanceof AssignmentTree assignment &&
                assignment.getVariable() instanceof IdentifierTree target) {
            flow.assign(new TreePath(route,assignment),assignment,target);
        } else if (tree instanceof ReturnTree returned && returned.getExpression()!=null) {
            returns.add(flow.returnValue(route,returned));
            return false;
        } else if (tree instanceof IfTree condition) {
            return branch(route,condition,depth);
        } else if (tree.getKind()!=Tree.Kind.EMPTY_STATEMENT) {
            throw new UnsupportedOperationException("Trace simple local assignments, finite if/else branches and value returns. Loops and other statements are outside this scope.");
        }
        return true;
    }

    private boolean branch(TreePath route, IfTree condition, int depth) {
        TreePath test=new TreePath(route,condition.getCondition());
        Flow.Value assessed=flow.expression(test);
        int start=flow.start(condition), end=flow.end(condition.getCondition());
        String caption=assessed.fact() instanceof Boolean value ? "Condition is "+value : "Condition may be true or false";
        int decision=flow.valueEvent("condition",caption,start,end,flow.controlled(assessed.inputs()),assessed.fact());
        var entry=new LinkedHashMap<>(flow.definitions);
        List<Integer> outer=flow.controls;
        var continuing=new ArrayList<Arm>();
        for (boolean side : new boolean[]{true,false}) {
            if (Boolean.valueOf(!side).equals(assessed.fact())) continue;
            StatementTree body=side ? condition.getThenStatement() : condition.getElseStatement();
            restore(entry,outer);
            int at=body==null?start:flow.start(body);
            int guard=flow.add("branch",side?"True branch":"False branch",at,at+1,flow.controlled(List.of(decision)));
            flow.controls=flow.controlled(List.of(guard));
            narrow(test,side,guard);
            boolean proceeds=body==null || visit(new TreePath(route,body),depth+1);
            if (proceeds) continuing.add(new Arm(new LinkedHashMap<>(flow.definitions),flow.controls));
        }
        if (continuing.isEmpty()) {
            restore(entry,outer);
            return false;
        }
        if (continuing.size()==1) {
            Arm surviving=continuing.getFirst();
            surviving.definitions().keySet().retainAll(entry.keySet());
            restore(surviving.definitions(),surviving.controls());
            return true;
        }
        restore(entry,outer);
        Arm yes=continuing.getFirst(), no=continuing.getLast();
        for (Element variable : entry.keySet()) {
            int left=yes.definitions().get(variable), right=no.definitions().get(variable);
            int joined=join(variable,left,right,decision,start,yes.controls(),no.controls());
            flow.definitions.put(variable,joined);
        }
        return true;
    }

    private int join(Element variable, int left, int right, int decision, int start,
                     List<Integer> yes, List<Integer> no) {
        if (left==right) return left;
        if (left<0 || right<0) return -1;
        Object fact=FlowFacts.common(flow.fact(left),flow.fact(right));
        int original=beforeAssumption(left);
        if (original==beforeAssumption(right)&&Objects.equals(fact,flow.fact(original))) return original;
        var inputs=new ArrayList<>(List.of(left,right,decision));
        inputs.addAll(yes);
        inputs.addAll(no);
        return flow.valueEvent("branch-merge","Join "+variable.getSimpleName(),start,start+2,flow.controlled(inputs),fact);
    }

    private int beforeAssumption(int value) {
        while (assumptions.containsKey(value)) value=assumptions.get(value);
        return value;
    }

    private void restore(Map<Element,Integer> values, List<Integer> controls) {
        flow.definitions.clear();
        flow.definitions.putAll(values);
        flow.controls=controls;
    }

    private void narrow(TreePath route, boolean taken, int guard) {
        Tree node=route.getLeaf();
        if (node instanceof ParenthesizedTree group) {
            narrow(new TreePath(route,group.getExpression()),taken,guard);
        } else if (node.getKind()==Tree.Kind.LOGICAL_COMPLEMENT && node instanceof UnaryTree unary) {
            narrow(new TreePath(route,unary.getExpression()),!taken,guard);
        } else if (node instanceof IdentifierTree && flow.trees.getElement(route) instanceof VariableElement variable &&
            variable.asType().getKind()==TypeKind.BOOLEAN) {
            assumption(route,variable,taken,guard);
        } else if (node instanceof BinaryTree binary &&
            (binary.getKind()==Tree.Kind.EQUAL_TO || binary.getKind()==Tree.Kind.NOT_EQUAL_TO)) {
            ExpressionTree left=binary.getLeftOperand(), right=binary.getRightOperand();
            boolean equal=taken==(binary.getKind()==Tree.Kind.EQUAL_TO);
            if (left.getKind()==Tree.Kind.NULL_LITERAL) narrowNull(new TreePath(route,right),equal,guard);
            if (right.getKind()==Tree.Kind.NULL_LITERAL) narrowNull(new TreePath(route,left),equal,guard);
        }
    }

    private void narrowNull(TreePath route, boolean nullBranch, int guard) {
        while (route.getLeaf() instanceof ParenthesizedTree group) route=new TreePath(route,group.getExpression());
        if (route.getLeaf() instanceof IdentifierTree && flow.trees.getElement(route) instanceof VariableElement variable &&
            variable.asType().toString().equals("java.lang.String")) {
            assumption(route,variable,nullBranch?FlowFacts.NULL:FlowFacts.STRING,guard);
        }
    }

    private void assumption(TreePath route, VariableElement variable, Object fact, int guard) {
        Integer previous=flow.definitions.get(variable);
        if (previous==null || previous<0 || flow.fact(previous)!=FlowFacts.UNKNOWN) return;
        Tree node=route.getLeaf();
        String visible=fact==FlowFacts.NULL?"null":fact==FlowFacts.STRING?"non-null":fact.toString();
        int narrowed=flow.valueEvent("narrowed",variable.getSimpleName()+" is "+visible,flow.start(node),flow.end(node),
            flow.controlled(List.of(previous,guard)),fact);
        assumptions.put(narrowed,previous);
        flow.definitions.put(variable,narrowed);
    }
}
