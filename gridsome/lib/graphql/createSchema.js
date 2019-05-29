const directives = require('./directives')
const initMustHaveTypes = require('./types')
const { scalarTypeResolvers } = require('./resolvers')
const { isPlainObject } = require('lodash')

const {
  isSpecifiedScalarType,
  isIntrospectionType,
  defaultFieldResolver
} = require('graphql')

const {
  SchemaComposer,
  UnionTypeComposer,
  ObjectTypeComposer
} = require('graphql-compose')

const {
  createTypeName,
  CreatedGraphQLType
} = require('./utils')

module.exports = function createSchema (store, context = {}) {
  const { types = [], schemas = [], resolvers = [] } = context
  const schemaComposer = new SchemaComposer()

  initMustHaveTypes(schemaComposer).forEach(typeComposer => {
    schemaComposer.addSchemaMustHaveType(typeComposer)
  })

  directives.forEach(directive => {
    schemaComposer.addDirective(directive)
  })

  types.forEach(typeOrSDL => {
    addTypes(schemaComposer, typeOrSDL)
  })

  const pagesSchema = require('./pages')(schemaComposer)
  const nodesSchema = require('./nodes')(schemaComposer, store)
  const metaData = require('./metaData')(schemaComposer, store)

  schemaComposer.Query.addFields(metaData)
  schemaComposer.Query.addFields(nodesSchema)
  schemaComposer.Query.addFields(pagesSchema)

  for (const typeComposer of schemaComposer.values()) {
    processObjectFields(schemaComposer, typeComposer)
  }

  schemas.forEach(schema => {
    addSchema(schemaComposer, schema)
  })

  resolvers.forEach(resolvers => {
    addResolvers(schemaComposer, resolvers)
  })

  return schemaComposer.buildSchema()
}

function addTypes (schemaComposer, typeOrSDL) {
  if (typeof typeOrSDL === 'string') {
    const sdlTypes = schemaComposer.addTypeDefs(typeOrSDL)
    sdlTypes.forEach(tempTypeComposer => {
      addCreatedType(schemaComposer, tempTypeComposer, true)
    })
  } else if (Array.isArray(typeOrSDL)) {
    typeOrSDL.forEach(type => {
      const tempTypeComposer = createType(schemaComposer, type)
      addCreatedType(schemaComposer, tempTypeComposer)
    })
  } else {
    const tempTypeComposer = createType(schemaComposer, typeOrSDL)
    addCreatedType(schemaComposer, tempTypeComposer)
  }
}

function createType (schemaComposer, type, path = [type.options.name]) {
  if (!type.options.name && path.length === 1) {
    throw new Error(`Missing required type name.`)
  }

  const name = type.options.name || createTypeName(path.join(' '))
  const options = { ...type.options, name }

  switch (type.type) {
    case CreatedGraphQLType.Object:
      const typeComposer = ObjectTypeComposer.createTemp(options, schemaComposer)
      const fields = typeComposer.getFields()

      typeComposer.extendExtensions(options.options || {})

      for (const fieldName in fields) {
        const fieldOptions = type.options.fields[fieldName]
        const fieldConfig = isPlainObject(fieldOptions) ? fieldOptions.options : {}

        typeComposer.extendFieldExtensions(fieldName, fieldConfig || {})
      }

      return typeComposer

    case CreatedGraphQLType.Union:
      return UnionTypeComposer.createTemp(options, schemaComposer)
  }
}

function addCreatedType (schemaComposer, type, isSDL = false) {
  const typeName = schemaComposer.add(type)
  const typeComposer = schemaComposer.get(typeName)

  typeComposer.setExtension('isUserDefined', true)

  if (isSDL && (typeComposer instanceof ObjectTypeComposer)) {
    typeComposer.getDirectives().forEach(directive => {
      typeComposer.setExtension(directive.name, directive.args)
    })

    Object.keys(typeComposer.getFields()).forEach(fieldName => {
      typeComposer.getFieldDirectives(fieldName).forEach(directive => {
        typeComposer.setFieldExtension(fieldName, directive.name, directive.args)
      })
    })
  }

  schemaComposer.addSchemaMustHaveType(typeComposer)
}

function processObjectFields (schemaComposer, typeComposer) {
  const isUserDefined = typeComposer.getExtension('isUserDefined')

  if (!(typeComposer instanceof ObjectTypeComposer)) return
  if (typeComposer === schemaComposer.Query) return
  if (!isUserDefined) return

  const fields = typeComposer.getFields()

  for (const fieldName in fields) {
    const fieldConfig = typeComposer.getFieldConfig(fieldName)
    const extensions = typeComposer.getFieldExtensions(fieldName)
    const resolver = getFieldResolver(typeComposer, fieldName, extensions)

    if (resolver) {
      const originalResolver = resolver.resolve || defaultFieldResolver
      const resolve = fieldConfig.resolve || originalResolver

      typeComposer.extendField(fieldName, {
        args: {
          ...resolver.args,
          ...fieldConfig.args
        },
        resolve (obj, args, ctx, info) {
          return resolve(obj, args, ctx, { ...info, originalResolver })
        }
      })
    }
  }
}

function getFieldResolver (typeComposer, fieldName) {
  const fieldComposer = typeComposer.getFieldTC(fieldName)

  if (
    fieldComposer instanceof ObjectTypeComposer &&
    fieldComposer.hasInterface('Node')
  ) {
    const isPlural = typeComposer.isFieldPlural(fieldName)
    const resolverName = isPlural ? 'findMany' : 'findOne'

    return fieldComposer.getResolver(resolverName)
  }

  return scalarTypeResolvers[fieldComposer.getTypeName()]
}

function addSchema (schemaComposer, schema) {
  const typeMap = schema.getTypeMap()
  const queryType = schema.getQueryType()
  const queryComposer = ObjectTypeComposer.createTemp(queryType, schemaComposer)
  const queryFields = queryComposer.getFields()

  schemaComposer.Query.addFields(queryFields)

  for (const typeName in typeMap) {
    const typeDef = typeMap[typeName]

    if (typeDef === queryType) continue
    if (isIntrospectionType(typeDef)) continue
    if (isSpecifiedScalarType(typeDef)) continue

    const typeComposer = schemaComposer.getAnyTC(typeDef.name)
    schemaComposer.addSchemaMustHaveType(typeComposer)
  }
}

function addResolvers (schemaComposer, resolvers = {}) {
  for (const typeName in resolvers) {
    const fields = resolvers[typeName]
    const typeComposer = schemaComposer.getOTC(typeName)

    for (const fieldName in fields) {
      const fieldOptions = fields[fieldName]

      if (typeComposer.hasField(fieldName)) {
        const field = typeComposer.getFieldConfig(fieldName)
        const originalResolver = field.resolve || defaultFieldResolver

        typeComposer.extendField(fieldName, {
          type: fieldOptions.type || field.type,
          args: fieldOptions.args || field.args,
          resolve (obj, args, ctx, info) {
            return fieldOptions.resolve(obj, args, ctx, { ...info, originalResolver })
          }
        })
      } else {
        if (!fieldOptions.type) {
          throw new Error(`${typeName}.${fieldName} must have a 'type' property.`)
        }

        typeComposer.addFields({ [fieldName]: fieldOptions })
      }
    }
  }
}
